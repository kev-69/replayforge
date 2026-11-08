import { randomBytes, randomUUID } from "node:crypto";

/**
 * In-memory data store.
 *
 * Seed data (users, products) is identical on every start, so v1 and v2 begin
 * from the same state. Generated values (tokens, order ids, timestamps) are
 * random on purpose: a replay will never get back the same token or order id
 * that was recorded. Dealing with that is the replay engine's job (Stage 4
 * correlation, Stage 5 normalization).
 *
 * Money is stored as integer cents, never floats.
 */

export interface User {
  id: string;
  username: string;
  password: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  priceCents: number;
  currency: "USD";
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface OrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  userId: string;
  status: "pending_payment" | "paid";
  items: OrderLine[];
  totalCents: number;
  currency: "USD";
  createdAt: string;
}

export interface Payment {
  id: string;
  orderId: string;
  status: "captured";
  method: "card" | "paypal";
  amountCents: number;
  currency: "USD";
  createdAt: string;
}

export const SEED_USER_COUNT = 100;
export const SEED_PASSWORD = "password123";
export const TOKEN_TTL_MS = 60 * 60 * 1000;

const SEED_PRODUCTS: ReadonlyArray<Omit<Product, "currency">> = [
  { id: "prod_001", name: "Mechanical Keyboard", category: "electronics", priceCents: 8999 },
  { id: "prod_002", name: "Wireless Mouse", category: "electronics", priceCents: 2999 },
  { id: "prod_003", name: "USB-C Hub", category: "electronics", priceCents: 4599 },
  { id: "prod_004", name: "27in Monitor", category: "electronics", priceCents: 27999 },
  { id: "prod_005", name: "Desk Lamp", category: "home", priceCents: 3499 },
  { id: "prod_006", name: "Ergonomic Chair", category: "home", priceCents: 34900 },
  { id: "prod_007", name: "Notebook (A5)", category: "stationery", priceCents: 899 },
  { id: "prod_008", name: "Gel Pens (12 pack)", category: "stationery", priceCents: 1299 },
  { id: "prod_009", name: "Coffee Beans 1kg", category: "grocery", priceCents: 2450 },
  { id: "prod_010", name: "Water Bottle", category: "home", priceCents: 1999 },
];

interface Session {
  userId: string;
  expiresAt: number;
}

export class Store {
  readonly products: ReadonlyArray<Product>;
  private readonly usersByName = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  private readonly carts = new Map<string, CartLine[]>();
  private readonly orders = new Map<string, Order>();
  private readonly payments = new Map<string, Payment>();

  constructor(private readonly now: () => number = Date.now) {
    this.products = SEED_PRODUCTS.map((p) => ({ ...p, currency: "USD" as const }));
    for (let i = 1; i <= SEED_USER_COUNT; i++) {
      const username = `user${String(i).padStart(3, "0")}`;
      this.usersByName.set(username, {
        id: `usr_${String(i).padStart(3, "0")}`,
        username,
        password: SEED_PASSWORD,
      });
    }
  }

  // --- auth ---------------------------------------------------------------

  login(
    username: string,
    password: string,
  ): { token: string; user: User; expiresAt: number } | null {
    const user = this.usersByName.get(username);
    if (!user || user.password !== password) return null;
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + TOKEN_TTL_MS;
    this.sessions.set(token, { userId: user.id, expiresAt });
    return { token, user, expiresAt };
  }

  userIdForToken(token: string): string | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session.userId;
  }

  // --- catalog ------------------------------------------------------------

  findProduct(id: string): Product | undefined {
    return this.products.find((p) => p.id === id);
  }

  // --- cart ---------------------------------------------------------------

  cart(userId: string): CartLine[] {
    return this.carts.get(userId) ?? [];
  }

  addToCart(userId: string, productId: string, quantity: number): CartLine[] {
    const lines = [...this.cart(userId)];
    const existing = lines.findIndex((l) => l.productId === productId);
    if (existing >= 0) {
      const line = lines[existing]!;
      lines[existing] = { productId, quantity: line.quantity + quantity };
    } else {
      lines.push({ productId, quantity });
    }
    this.carts.set(userId, lines);
    return lines;
  }

  // --- orders & payments --------------------------------------------------

  /** Turns the cart into an order and empties the cart. Returns null if the cart is empty. */
  checkout(userId: string): Order | null {
    const lines = this.cart(userId);
    if (lines.length === 0) return null;
    const items: OrderLine[] = lines.map((l) => {
      const product = this.findProduct(l.productId)!;
      return {
        productId: product.id,
        name: product.name,
        quantity: l.quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * l.quantity,
      };
    });
    const order: Order = {
      id: `ord_${randomUUID()}`,
      userId,
      status: "pending_payment",
      items,
      totalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0),
      currency: "USD",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.orders.set(order.id, order);
    this.carts.delete(userId);
    return order;
  }

  findOrder(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  pay(order: Order, method: Payment["method"]): Payment {
    const payment: Payment = {
      id: `pay_${randomUUID()}`,
      orderId: order.id,
      status: "captured",
      method,
      amountCents: order.totalCents,
      currency: order.currency,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.payments.set(payment.id, payment);
    order.status = "paid";
    return payment;
  }
}
