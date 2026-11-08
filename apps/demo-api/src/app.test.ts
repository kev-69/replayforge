import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySink } from "@replayforge/capture";
import { buildApp, type BuildAppOptions } from "./app.js";

/**
 * These tests use fastify.inject(): requests go through the full Fastify
 * pipeline (hooks, parsing, routing, serialization) without opening a socket.
 */

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

function start(options: BuildAppOptions = {}): FastifyInstance {
  app = buildApp(options);
  return app;
}

async function login(username = "user001"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "password123" },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

/** Runs the full shopping journey and returns every response in order. */
async function journey() {
  const token = await login();
  const auth = { authorization: `Bearer ${token}` };
  const products = await app.inject({ method: "GET", url: "/api/products", headers: auth });
  const product = await app.inject({ method: "GET", url: "/api/products/prod_002", headers: auth });
  const addItem = await app.inject({
    method: "POST",
    url: "/api/cart/items",
    headers: auth,
    payload: { productId: "prod_002", quantity: 2 },
  });
  const cart = await app.inject({ method: "GET", url: "/api/cart", headers: auth });
  const order = await app.inject({
    method: "POST",
    url: "/api/orders",
    headers: auth,
    payload: {},
  });
  const payment = await app.inject({
    method: "POST",
    url: "/api/payments",
    headers: auth,
    payload: { orderId: order.json<{ id: string }>().id, method: "card" },
  });
  return { auth, products, product, addItem, cart, order, payment };
}

describe("demo-api", () => {
  it("serves the complete shopping journey", async () => {
    start();
    const r = await journey();

    expect(r.products.statusCode).toBe(200);
    expect(r.products.json()).toMatchObject({ total: 10 });

    expect(r.product.statusCode).toBe(200);
    expect(r.product.json()).toEqual({
      id: "prod_002",
      name: "Wireless Mouse",
      category: "electronics",
      price: 2999,
      currency: "USD",
    });

    expect(r.addItem.statusCode).toBe(201);
    expect(r.cart.json()).toMatchObject({
      subtotal: 5998,
      items: [{ productId: "prod_002", quantity: 2 }],
    });

    expect(r.order.statusCode).toBe(201);
    expect(r.order.json()).toMatchObject({ status: "pending_payment", total: 5998 });

    expect(r.payment.statusCode).toBe(201);
    expect(r.payment.json()).toMatchObject({ status: "captured", amount: 5998 });
  });

  it("generates a different token on every login", async () => {
    start();
    expect(await login()).not.toBe(await login());
  });

  it("rejects requests without a valid token", async () => {
    start();
    const missing = await app.inject({ method: "GET", url: "/api/cart" });
    expect(missing.statusCode).toBe(401);
    const bogus = await app.inject({
      method: "GET",
      url: "/api/cart",
      headers: { authorization: "Bearer nope" },
    });
    expect(bogus.statusCode).toBe(401);
    expect(bogus.json()).toEqual({ error: "unauthorized", message: "invalid or expired token" });
  });

  it("validates request bodies", async () => {
    start();
    const token = await login();
    const res = await app.inject({
      method: "POST",
      url: "/api/cart/items",
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: "prod_001", quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "validation_error" });
  });

  it("rejects bad credentials, unknown products, empty carts and double payment", async () => {
    start();
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "user001", password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const unknown = await app.inject({ method: "GET", url: "/api/products/prod_999" });
    expect(unknown.statusCode).toBe(404);

    const token = await login();
    const empty = await app.inject({
      method: "POST",
      url: "/api/orders",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const r = await journey();
    const again = await app.inject({
      method: "POST",
      url: "/api/payments",
      headers: r.auth,
      payload: { orderId: r.order.json<{ id: string }>().id, method: "card" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("demo-api with capture enabled", () => {
  it("records one exchange per request of the journey, in arrival order", async () => {
    const sink = new MemorySink();
    start({
      capture: { sink, service: { name: "demo-api", version: "test" }, exclude: ["/health"] },
    });

    await app.inject({ method: "GET", url: "/health" }); // excluded
    await journey();

    const lines = sink.exchanges.map(
      (e) => `${e.response.status} ${e.request.method} ${e.request.route}`,
    );
    expect(lines).toEqual([
      "200 POST /api/auth/login",
      "200 GET /api/products",
      "200 GET /api/products/:id",
      "201 POST /api/cart/items",
      "200 GET /api/cart",
      "201 POST /api/orders",
      "201 POST /api/payments",
    ]);
    expect(sink.exchanges.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Everything after login shares one session key (same bearer token); login itself has none.
    const [loginEx, ...rest] = sink.exchanges;
    expect(loginEx!.sessionKey).toBeNull();
    expect(new Set(rest.map((e) => e.sessionKey)).size).toBe(1);

    await app.close();
    expect(sink.closed).toBe(true);
  });
});
