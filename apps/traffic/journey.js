// k6 traffic generator: simulates shoppers running through the demo API.
// It runs inside k6's JavaScript runtime (not Node), started by:
//   docker compose run --rm k6
//
// Env vars:
//   BASE_URL    target API          (default http://localhost:3001)
//   ITERATIONS  number of journeys  (default 200)
//   VUS         concurrent users    (default 10)
//   USERS       seeded user count   (default 100; must match the demo-api seed)
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001";
const USERS = Number(__ENV.USERS || 100);

export const options = {
  scenarios: {
    journeys: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 10),
      iterations: Number(__ENV.ITERATIONS || 200),
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate>0.95"],
  },
};

const JSON_HEADERS = { "Content-Type": "application/json" };

/** A short random pause, so the recording has realistic gaps between requests. */
function think() {
  sleep(0.05 + Math.random() * 0.15);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export default function () {
  const userNumber = ((__VU * 7919 + __ITER) % USERS) + 1;
  const username = `user${String(userNumber).padStart(3, "0")}`;

  // 1. login
  const login = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username, password: "password123" }),
    { headers: JSON_HEADERS, tags: { name: "POST /api/auth/login" } },
  );
  if (!check(login, { "login: 200": (r) => r.status === 200 })) return;
  const params = (name) => ({
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${login.json("token")}` },
    tags: { name },
  });
  think();

  // 2. browse the catalog
  const products = http.get(`${BASE_URL}/api/products`, params("GET /api/products"));
  if (!check(products, { "products: 200": (r) => r.status === 200 })) return;
  const items = products.json("items");
  think();

  // 3. look at one product (tag groups all /api/products/:id calls together)
  const viewed = pick(items);
  const detail = http.get(`${BASE_URL}/api/products/${viewed.id}`, params("GET /api/products/:id"));
  check(detail, { "product detail: 200": (r) => r.status === 200 });
  think();

  // 4. add 1-3 items to the cart
  const lines = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < lines; i++) {
    const added = http.post(
      `${BASE_URL}/api/cart/items`,
      JSON.stringify({ productId: pick(items).id, quantity: 1 + Math.floor(Math.random() * 3) }),
      params("POST /api/cart/items"),
    );
    check(added, { "add to cart: 201": (r) => r.status === 201 });
    think();
  }

  // 5. view the cart
  const cart = http.get(`${BASE_URL}/api/cart`, params("GET /api/cart"));
  check(cart, { "cart: 200": (r) => r.status === 200 });
  think();

  // 6. checkout
  const order = http.post(`${BASE_URL}/api/orders`, JSON.stringify({}), params("POST /api/orders"));
  if (!check(order, { "order: 201": (r) => r.status === 201 })) return;
  think();

  // 7. pay
  const payment = http.post(
    `${BASE_URL}/api/payments`,
    JSON.stringify({ orderId: order.json("id"), method: "card" }),
    params("POST /api/payments"),
  );
  check(payment, { "payment: 201": (r) => r.status === 201 });
}
