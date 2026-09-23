/**
 * "shopkit": a generated shop backend of about 110 files, the repo for the hard eval suite.
 * It is large enough that searching matters: 20 domain folders that look alike,
 * a core library, an API layer and tests. The base version is correct: all tests pass.
 * Each hard task breaks or changes a few files (see hardTasks.ts).
 */

const lines = (...l: string[]) => `${l.join("\n")}\n`;

interface Entity {
  name: string;
  Name: string;
  prefix: string;
  fields: string[];
  /** Field with a money amount: the service gets a describe() that uses formatPrice. */
  amount?: string;
}

const entity = (name: string, prefix: string, fields: string[], amount?: string): Entity => ({
  name,
  Name: name[0]?.toUpperCase() + name.slice(1),
  prefix,
  fields,
  ...(amount === undefined ? {} : { amount }),
});

/** Entities built from templates. order, stock and invoice are hand-written below. */
export const ENTITIES: readonly Entity[] = [
  entity("product", "prd", ["name", "price"], "price"),
  entity("customer", "cus", ["name", "email"]),
  entity("cart", "crt", ["customerId"]),
  entity("shipment", "shp", ["orderId", "carrier"]),
  entity("warehouse", "whs", ["name", "city"]),
  entity("supplier", "sup", ["name", "country"]),
  entity("coupon", "cpn", ["code", "percent"]),
  entity("review", "rev", ["productId", "stars"]),
  entity("category", "cat", ["name"]),
  entity("payment", "pay", ["orderId", "amount"], "amount"),
  entity("refund", "ref", ["paymentId", "amount"], "amount"),
  entity("address", "adr", ["customerId", "line1", "postcode"]),
  entity("price", "prc", ["productId", "value"]),
  entity("tax", "tax", ["region", "rate"]),
  entity("discount", "dsc", ["name", "amount"], "amount"),
  entity("report", "rpt", ["title"]),
  entity("user", "usr", ["login", "role"]),
];

function model(e: Entity): string {
  return lines(
    'import { newId } from "../../core/ids.js";',
    "",
    `/** Create a ${e.name} record. */`,
    `export function create${e.Name}(fields) {`,
    `  return { id: newId("${e.prefix}"), ...fields };`,
    "}",
  );
}

function validate(e: Entity): string {
  return lines(
    'import { ValidationError } from "../../core/errors.js";',
    "",
    `const REQUIRED = [${e.fields.map((f) => `"${f}"`).join(", ")}];`,
    "",
    `export function validate${e.Name}(input) {`,
    "  for (const key of REQUIRED) {",
    `    if (input?.[key] === undefined) throw new ValidationError(\`${e.name}.\${key} is required\`);`,
    "  }",
    "  return input;",
    "}",
  );
}

function repository(e: Entity): string {
  return lines(
    `export class ${e.Name}Repository {`,
    "  #items = new Map();",
    "",
    "  add(item) {",
    "    this.#items.set(item.id, item);",
    "    return item;",
    "  }",
    "",
    "  get(id) {",
    "    return this.#items.get(id);",
    "  }",
    "",
    "  listAll() {",
    "    return [...this.#items.values()];",
    "  }",
    "",
    "  remove(id) {",
    "    return this.#items.delete(id);",
    "  }",
    "}",
  );
}

function service(e: Entity): string {
  const money = e.amount !== undefined;
  return lines(
    'import { events } from "../../core/events.js";',
    ...(money ? ['import { formatPrice, toCents } from "../../core/money.js";'] : []),
    `import { create${e.Name} } from "./model.js";`,
    `import { ${e.Name}Repository } from "./repository.js";`,
    `import { validate${e.Name} } from "./validate.js";`,
    "",
    `export class ${e.Name}Service {`,
    `  constructor({ repo = new ${e.Name}Repository(), bus = events } = {}) {`,
    "    this.repo = repo;",
    "    this.bus = bus;",
    "  }",
    "",
    "  create(input) {",
    `    const item = this.repo.add(create${e.Name}(validate${e.Name}(input)));`,
    `    this.bus.emit("${e.name}.created", item);`,
    "    return item;",
    "  }",
    "",
    "  find(id) {",
    "    return this.repo.get(id);",
    "  }",
    "",
    "  all() {",
    "    return this.repo.listAll();",
    "  }",
    ...(money
      ? [
          "",
          "  describe(item) {",
          `    return \`${e.Name} \${item.id}: \${formatPrice(toCents(item.${e.amount}))}\`;`,
          "  }",
        ]
      : []),
    "}",
  );
}

function entityTest(e: Entity): string {
  const sample = Object.fromEntries(e.fields.map((f, i) => [f, i === 0 ? `x-${e.name}` : 3]));
  return lines(
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { EventBus } from "../../src/core/events.js";',
    `import { ${e.Name}Service } from "../../src/domains/${e.name}/service.js";`,
    "",
    `test("${e.name}: create, find, list", () => {`,
    `  const service = new ${e.Name}Service({ bus: new EventBus() });`,
    `  const item = service.create(${JSON.stringify(sample)});`,
    "  assert.equal(service.find(item.id), item);",
    "  assert.equal(service.all().length, 1);",
    `  assert.match(item.id, /^${e.prefix}_/);`,
    "});",
    "",
    `test("${e.name}: validation", () => {`,
    `  const service = new ${e.Name}Service({ bus: new EventBus() });`,
    `  assert.throws(() => service.create({}), /${e.name}\\.${e.fields[0]} is required/);`,
    "});",
  );
}

const CORE: Record<string, string> = {
  "src/core/ids.js": lines(
    "let next = 1;",
    "",
    "/** Ids like prd_000001. Sequential, so tests are stable. */",
    "export function newId(prefix) {",
    '  return `${prefix}_${String(next++).padStart(6, "0")}`;',
    "}",
  ),
  "src/core/errors.js": lines(
    "export class ValidationError extends Error {",
    '  name = "ValidationError";',
    "}",
    "",
    "export class NotFoundError extends Error {",
    '  name = "NotFoundError";',
    "}",
  ),
  "src/core/events.js": lines(
    "export class EventBus {",
    "  #handlers = new Map();",
    "",
    "  on(name, handler) {",
    "    const list = this.#handlers.get(name) ?? [];",
    "    list.push(handler);",
    "    this.#handlers.set(name, list);",
    "  }",
    "",
    "  emit(name, payload) {",
    "    for (const handler of this.#handlers.get(name) ?? []) handler(payload);",
    "  }",
    "}",
    "",
    "/** The shared bus. Tests pass their own. */",
    "export const events = new EventBus();",
  ),
  "src/core/money.js": lines(
    "/** Amounts are numbers in pounds. Totals are integers in pence. */",
    "export function toCents(amount) {",
    "  return Math.round(amount * 100);",
    "}",
    "",
    'export function formatPrice(cents, symbol = "£") {',
    '  const sign = cents < 0 ? "-" : "";',
    "  const abs = Math.abs(cents);",
    '  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;',
    "}",
  ),
  "src/core/strings.js": lines(
    "export function capitalize(text) {",
    "  return text.charAt(0).toUpperCase() + text.slice(1);",
    "}",
    "",
    "export function slug(text) {",
    '  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");',
    "}",
    "",
    "export function truncate(text, max) {",
    "  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;",
    "}",
    "",
    'export function padLeft(text, width, fill = " ") {',
    "  return String(text).padStart(width, fill);",
    "}",
  ),
  "src/core/dates.js": lines(
    "const DAY = 24 * 60 * 60 * 1000;",
    "",
    "export function addDays(date, days) {",
    "  return new Date(date.getTime() + days * DAY);",
    "}",
    "",
    "export function toIsoDate(date) {",
    "  return date.toISOString().slice(0, 10);",
    "}",
    "",
    "export function isWeekend(date) {",
    "  const day = date.getUTCDay();",
    "  return day === 0 || day === 6;",
    "}",
  ),
  "src/core/config.js": lines(
    'const DEFAULTS = { port: 3000, currency: "GBP", invoiceDays: 30 };',
    "",
    "export function loadConfig(overrides = {}) {",
    "  return { ...DEFAULTS, ...overrides };",
    "}",
  ),
  "src/core/logger.js": lines(
    "export function createLogger(name, sink = () => {}) {",
    "  return {",
    "    info: (message) => sink(`[${name}] ${message}`),",
    "    error: (message) => sink(`[${name}] ERROR ${message}`),",
    "  };",
    "}",
  ),
};

const HAND_WRITTEN: Record<string, string> = {
  // order: totals, events, describe
  "src/domains/order/model.js": model(entity("order", "ord", [])),
  "src/domains/order/repository.js": repository(entity("order", "ord", [])),
  "src/domains/order/service.js": lines(
    'import { NotFoundError, ValidationError } from "../../core/errors.js";',
    'import { events } from "../../core/events.js";',
    'import { formatPrice, toCents } from "../../core/money.js";',
    'import { createOrder } from "./model.js";',
    'import { OrderRepository } from "./repository.js";',
    "",
    "export class OrderService {",
    "  constructor({ products, repo = new OrderRepository(), bus = events } = {}) {",
    "    this.products = products;",
    "    this.repo = repo;",
    "    this.bus = bus;",
    "  }",
    "",
    "  create({ customerId, lines }) {",
    '    if (!lines?.length) throw new ValidationError("order.lines is required");',
    "    let totalCents = 0;",
    "    for (const line of lines) {",
    "      const product = this.products.find(line.productId);",
    "      if (!product) throw new NotFoundError(`product ${line.productId}`);",
    "      totalCents += toCents(product.price) * line.qty;",
    "    }",
    "    const order = this.repo.add(createOrder({ customerId, lines, totalCents }));",
    '    this.bus.emit("order.created", order);',
    "    return order;",
    "  }",
    "",
    "  find(id) {",
    "    return this.repo.get(id);",
    "  }",
    "",
    "  all() {",
    "    return this.repo.listAll();",
    "  }",
    "",
    "  describe(order) {",
    "    return `Order ${order.id}: ${formatPrice(order.totalCents)}`;",
    "  }",
    "}",
  ),
  // stock: reacts to order.created
  "src/domains/stock/service.js": lines(
    'import { events } from "../../core/events.js";',
    "",
    "/** Stock levels per product. Orders reserve stock through the order.created event. */",
    "export class StockService {",
    "  #levels = new Map();",
    "",
    "  constructor({ bus = events } = {}) {",
    '    bus.on("order.created", (order) => this.reserve(order));',
    "  }",
    "",
    "  set(productId, qty) {",
    "    this.#levels.set(productId, qty);",
    "  }",
    "",
    "  level(productId) {",
    "    return this.#levels.get(productId) ?? 0;",
    "  }",
    "",
    "  reserve(order) {",
    "    for (const line of order.lines) this.set(line.productId, this.level(line.productId) - line.qty);",
    "  }",
    "}",
  ),
  // invoice: formats the order total
  "src/domains/invoice/service.js": lines(
    'import { loadConfig } from "../../core/config.js";',
    'import { addDays, toIsoDate } from "../../core/dates.js";',
    'import { formatPrice } from "../../core/money.js";',
    "",
    "export class InvoiceService {",
    "  constructor({ config = loadConfig() } = {}) {",
    "    this.config = config;",
    "  }",
    "",
    "  fromOrder(order, issued = new Date(Date.UTC(2026, 0, 1))) {",
    "    return {",
    "      orderId: order.id,",
    "      amount: formatPrice(order.totalCents),",
    "      issuedOn: toIsoDate(issued),",
    "      dueOn: toIsoDate(addDays(issued, this.config.invoiceDays)),",
    "    };",
    "  }",
    "}",
  ),
  "src/api/routes.js": lines(
    'import { loadConfig } from "../core/config.js";',
    'import { createLogger } from "../core/logger.js";',
    'import { capitalize, slug } from "../core/strings.js";',
    'import { CustomerService } from "../domains/customer/service.js";',
    'import { OrderService } from "../domains/order/service.js";',
    'import { ProductService } from "../domains/product/service.js";',
    'import { ShipmentService } from "../domains/shipment/service.js";',
    "",
    "/** Build the route table. Handlers take a body and return a result. */",
    'export function buildRoutes(log = createLogger("api")) {',
    "  const config = loadConfig();",
    "  const products = new ProductService();",
    "  const orders = new OrderService({ products });",
    "  const customers = new CustomerService();",
    "  const shipments = new ShipmentService();",
    "  const routes = {",
    '    "POST /products": (body) => products.create(body),',
    '    "POST /customers": (body) => customers.create(body),',
    '    "POST /orders": (body) => orders.create(body),',
    '    "POST /shipments": (body) => shipments.create(body),',
    "  };",
    "  log.info(`${Object.keys(routes).length} routes on port ${config.port}`);",
    "  return routes;",
    "}",
    "",
    "export function routeTitle(route) {",
    '  return capitalize(slug(route.split(" ")[1] ?? ""));',
    "}",
  ),
};

const imp = (names: string, from: string) =>
  [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    `import { ${names} } from "${from}";`,
  ].join("\n");

const FEATURE_TESTS: Record<string, string> = {
  "test/features/order-total.test.js": lines(
    imp("EventBus", "../../src/core/events.js"),
    'import { OrderService } from "../../src/domains/order/service.js";',
    'import { ProductService } from "../../src/domains/product/service.js";',
    "",
    'test("order total in pence", () => {',
    "  const bus = new EventBus();",
    "  const products = new ProductService({ bus });",
    '  const pen = products.create({ name: "pen", price: 0.29 });',
    '  const pad = products.create({ name: "pad", price: 1.15 });',
    "  const orders = new OrderService({ products, bus });",
    '  const order = orders.create({ customerId: "c1", lines: [{ productId: pen.id, qty: 3 }, { productId: pad.id, qty: 1 }] });',
    "  assert.equal(order.totalCents, 202);",
    "  assert.equal(orders.describe(order), `Order ${order.id}: £2.02`);",
    "});",
  ),
  "test/features/invoice.test.js": lines(
    imp("EventBus", "../../src/core/events.js"),
    'import { InvoiceService } from "../../src/domains/invoice/service.js";',
    'import { OrderService } from "../../src/domains/order/service.js";',
    'import { ProductService } from "../../src/domains/product/service.js";',
    "",
    'test("invoice from an order", () => {',
    "  const bus = new EventBus();",
    "  const products = new ProductService({ bus });",
    '  const tea = products.create({ name: "tea", price: 0.57 });',
    '  const order = new OrderService({ products, bus }).create({ customerId: "c1", lines: [{ productId: tea.id, qty: 1 }] });',
    "  const invoice = new InvoiceService().fromOrder(order);",
    '  assert.deepEqual(invoice, { orderId: order.id, amount: "£0.57", issuedOn: "2026-01-01", dueOn: "2026-01-31" });',
    "});",
  ),
  "test/features/stock.test.js": lines(
    imp("EventBus", "../../src/core/events.js"),
    'import { OrderService } from "../../src/domains/order/service.js";',
    'import { ProductService } from "../../src/domains/product/service.js";',
    'import { StockService } from "../../src/domains/stock/service.js";',
    "",
    'test("an order reserves stock", () => {',
    "  const bus = new EventBus();",
    "  const products = new ProductService({ bus });",
    "  const stock = new StockService({ bus });",
    '  const mug = products.create({ name: "mug", price: 4 });',
    "  stock.set(mug.id, 10);",
    '  new OrderService({ products, bus }).create({ customerId: "c1", lines: [{ productId: mug.id, qty: 3 }] });',
    "  assert.equal(stock.level(mug.id), 7);",
    "});",
  ),
  "test/api/routes.test.js": lines(
    imp("buildRoutes, routeTitle", "../../src/api/routes.js"),
    "",
    'test("routes", () => {',
    "  const logs = [];",
    "  const routes = buildRoutes({ info: (m) => logs.push(m), error: () => {} });",
    '  assert.deepEqual(Object.keys(routes).sort(), ["POST /customers", "POST /orders", "POST /products", "POST /shipments"]);',
    '  assert.deepEqual(logs, ["4 routes on port 3000"]);',
    '  assert.equal(routeTitle("POST /products"), "Products");',
    "});",
  ),
  "test/core/money.test.js": lines(
    imp("formatPrice, toCents", "../../src/core/money.js"),
    "",
    'test("money", () => {',
    "  assert.equal(toCents(0.29), 29);",
    '  assert.equal(formatPrice(1205), "£12.05");',
    '  assert.equal(formatPrice(-5), "-£0.05");',
    "});",
  ),
  "test/core/strings.test.js": lines(
    imp("capitalize, padLeft, slug, truncate", "../../src/core/strings.js"),
    "",
    'test("strings", () => {',
    '  assert.equal(capitalize("abc"), "Abc");',
    '  assert.equal(slug("Hello World!"), "hello-world");',
    '  assert.equal(truncate("abcdef", 4), "abc…");',
    '  assert.equal(padLeft(7, 3, "0"), "007");',
    "});",
  ),
};

/** The whole base repo: every test passes. */
export function shopkit(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json":
      '{ "name": "shopkit", "version": "2.4.0", "type": "module", "private": true }\n',
    "README.md": lines(
      "# shopkit",
      "",
      "A small shop backend. Domains live in src/domains/<name>/ (model, repository, service, validate).",
      "Shared code lives in src/core/. The route table is in src/api/routes.js.",
      "Run the tests with: node --test",
    ),
    ...CORE,
    ...HAND_WRITTEN,
    ...FEATURE_TESTS,
  };
  for (const e of ENTITIES) {
    files[`src/domains/${e.name}/model.js`] = model(e);
    files[`src/domains/${e.name}/validate.js`] = validate(e);
    files[`src/domains/${e.name}/repository.js`] = repository(e);
    files[`src/domains/${e.name}/service.js`] = service(e);
    files[`test/domains/${e.name}.test.js`] = entityTest(e);
  }
  return files;
}
