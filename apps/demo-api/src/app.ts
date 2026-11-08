import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { replayforgeCapture, type CaptureOptions } from "@replayforge/capture";
import { HttpError } from "./http-error.js";
import { Store, type CartLine, type Order, type Payment, type Product } from "./store.js";

export interface BuildAppOptions {
  /** When set, every request/response is recorded with the ReplayForge capture plugin. */
  capture?: CaptureOptions;
  logger?: boolean;
}

// --- request validation (Zod) ----------------------------------------------

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const AddCartItemBody = z.object({
  productId: z.string().min(1),
  quantity: z.int().min(1).max(10),
});

const CreateOrderBody = z.object({ note: z.string().max(200).optional() }).optional();

const CreatePaymentBody = z.object({
  orderId: z.string().min(1),
  method: z.enum(["card", "paypal"]),
});

const ProductListQuery = z.object({ category: z.string().optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new HttpError(400, "validation_error", detail);
  }
  return result.data;
}

// --- views: how internal records are shown to clients ------------------------

const productView = (p: Product) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  price: p.priceCents,
  currency: p.currency,
});

const orderView = (o: Order) => ({
  id: o.id,
  status: o.status,
  items: o.items.map((i) => ({
    productId: i.productId,
    name: i.name,
    quantity: i.quantity,
    unitPrice: i.unitPriceCents,
    lineTotal: i.lineTotalCents,
  })),
  total: o.totalCents,
  currency: o.currency,
  createdAt: o.createdAt,
});

const paymentView = (p: Payment) => ({
  id: p.id,
  orderId: p.orderId,
  status: p.status,
  method: p.method,
  amount: p.amountCents,
  currency: p.currency,
  createdAt: p.createdAt,
});

// --- app -------------------------------------------------------------------

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const store = new Store();
  const app = Fastify({ logger: options.logger ?? false });

  // Register capture FIRST so its hooks see every request, including ones
  // that fail validation or don't match a route.
  if (options.capture) {
    app.register(replayforgeCapture, options.capture);
  }

  const cartView = (lines: CartLine[]) => {
    const items = lines.map((l) => {
      const p = store.findProduct(l.productId)!;
      return {
        productId: p.id,
        name: p.name,
        quantity: l.quantity,
        unitPrice: p.priceCents,
        lineTotal: p.priceCents * l.quantity,
      };
    });
    return { items, subtotal: items.reduce((s, i) => s + i.lineTotal, 0), currency: "USD" };
  };

  /** Resolves the bearer token to a user id, or throws 401. */
  const requireUser = (request: FastifyRequest): string => {
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw new HttpError(401, "unauthorized", "missing bearer token");
    }
    const userId = store.userIdForToken(token);
    if (!userId) throw new HttpError(401, "unauthorized", "invalid or expired token");
    return userId;
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    // Fastify's own client errors (bad JSON, wrong content type, ...) carry a 4xx statusCode.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      const code = (error as { code?: string }).code ?? "bad_request";
      return reply.code(statusCode).send({ error: code, message: (error as Error).message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error", message: "unexpected error" });
  });

  // --- routes --------------------------------------------------------------

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/auth/login", async (request) => {
    const body = parse(LoginBody, request.body);
    const session = store.login(body.username, body.password);
    if (!session) throw new HttpError(401, "invalid_credentials", "invalid username or password");
    return {
      token: session.token,
      tokenType: "Bearer",
      expiresAt: new Date(session.expiresAt).toISOString(),
      user: { id: session.user.id, username: session.user.username },
    };
  });

  app.get("/api/products", async (request) => {
    const query = parse(ProductListQuery, request.query);
    const items = store.products
      .filter((p) => !query.category || p.category === query.category)
      .map(productView);
    return { items, total: items.length };
  });

  app.get<{ Params: { id: string } }>("/api/products/:id", async (request) => {
    const product = store.findProduct(request.params.id);
    if (!product) throw new HttpError(404, "not_found", `product ${request.params.id} not found`);
    return productView(product);
  });

  app.post("/api/cart/items", async (request, reply) => {
    const userId = requireUser(request);
    const body = parse(AddCartItemBody, request.body);
    if (!store.findProduct(body.productId)) {
      throw new HttpError(404, "not_found", `product ${body.productId} not found`);
    }
    const lines = store.addToCart(userId, body.productId, body.quantity);
    return reply.code(201).send(cartView(lines));
  });

  app.get("/api/cart", async (request) => {
    const userId = requireUser(request);
    return cartView(store.cart(userId));
  });

  app.post("/api/orders", async (request, reply) => {
    const userId = requireUser(request);
    parse(CreateOrderBody, request.body);
    const order = store.checkout(userId);
    if (!order) throw new HttpError(400, "empty_cart", "cannot create an order from an empty cart");
    return reply.code(201).send(orderView(order));
  });

  app.post("/api/payments", async (request, reply) => {
    const userId = requireUser(request);
    const body = parse(CreatePaymentBody, request.body);
    const order = store.findOrder(body.orderId);
    if (!order || order.userId !== userId) {
      throw new HttpError(404, "not_found", `order ${body.orderId} not found`);
    }
    if (order.status === "paid") {
      throw new HttpError(409, "already_paid", `order ${order.id} is already paid`);
    }
    return reply.code(201).send(paymentView(store.pay(order, body.method)));
  });

  return app;
}
