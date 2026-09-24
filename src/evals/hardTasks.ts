import { shopkit } from "./shopkit.js";
import type { EvalTask } from "./types.js";

/**
 * The hard eval suite: 6 tasks on shopkit (about 110 files, 20 look-alike domain folders).
 * Each task needs search across files, so it measures how well the agent finds code,
 * not only how well it edits. The base repo passes all tests; each task breaks or changes it.
 */

const BASE = shopkit();
const base = (path: string): string => {
  const content = BASE[path];
  if (content === undefined) throw new Error(`shopkit has no ${path}`);
  return content;
};

/** A task: the base repo with some files replaced. The solution restores or adds files. */
function task(fields: Omit<EvalTask, "files"> & { change: Record<string, string> }): EvalTask {
  const { change, ...rest } = fields;
  return { ...rest, files: { ...BASE, ...change } };
}

const replaceIn = (path: string, from: string, to: string): string => {
  const content = base(path);
  if (!content.includes(from)) throw new Error(`${path} has no "${from}"`);
  return content.split(from).join(to);
};

/** Every src file that uses formatPrice, with the new name. */
const renamed = Object.fromEntries(
  Object.entries(BASE)
    .filter(([path, content]) => path.startsWith("src/") && content.includes("formatPrice"))
    .map(([path, content]) => [path, content.split("formatPrice").join("formatMoney")]),
);

export const HARD_TASKS: readonly EvalTask[] = [
  task({
    id: "hard-rounding",
    title: "Find a root cause in shared code",
    prompt:
      "Several tests about orders and invoices fail. Find the root cause and fix it. Do not change the tests.",
    change: {
      "src/core/money.js": replaceIn(
        "src/core/money.js",
        "Math.round(amount * 100)",
        "Math.floor(amount * 100)",
      ),
    },
    check: "node --test",
    solution: { "src/core/money.js": base("src/core/money.js") },
  }),
  task({
    id: "hard-event",
    title: "Fix a mismatch between two modules",
    prompt:
      "Creating an order no longer reserves stock. Find out why and fix it. Do not change the tests.",
    change: {
      "src/domains/stock/service.js": replaceIn(
        "src/domains/stock/service.js",
        '"order.created"',
        '"orders.created"',
      ),
    },
    check: "node --test",
    solution: { "src/domains/stock/service.js": base("src/domains/stock/service.js") },
  }),
  task({
    id: "hard-import",
    title: "Fix a broken import in a large repo",
    prompt: "The API routes test crashes. Fix it. Do not change the tests.",
    change: {
      "src/api/routes.js": replaceIn(
        "src/api/routes.js",
        "domains/shipment/service.js",
        "domains/shipments/service.js",
      ),
    },
    check: "node --test",
    solution: { "src/api/routes.js": base("src/api/routes.js") },
  }),
  task({
    id: "hard-rename",
    title: "Rename a shared function in every file",
    prompt:
      "Rename the function formatPrice (in src/core/money.js) to formatMoney: the definition and every import and call in src/. The tests already use the new name.",
    change: {
      "test/core/money.test.js": base("test/core/money.test.js")
        .split("formatPrice")
        .join("formatMoney"),
    },
    check: "node --test && ! grep -rq formatPrice src",
    solution: renamed,
  }),
  task({
    id: "hard-unused",
    title: "Find unused exports",
    prompt:
      "Which exported functions in src/core/ are not used by any other file in src/? Count only functions declared with the `function` keyword: classes and constants do not count. Uses in test/ do not count. Write the names to unused.txt, one per line, in alphabetical order. Do not change any other file.",
    change: {},
    // diff prints the expected and the actual lines, so a failure shows what the agent wrote.
    check:
      'diff <(printf "isWeekend\\npadLeft\\ntruncate\\n") <(tr -d " \\r" < unused.txt | grep -v "^$")',
    protect: Object.keys(BASE).filter((p) => p.startsWith("src/")),
    solution: { "unused.txt": "isWeekend\npadLeft\ntruncate\n" },
  }),
  task({
    id: "hard-coupon",
    title: "Add a feature across modules",
    prompt:
      "Add coupon support to orders. When OrderService.create() gets a couponCode, find the coupon with that code and take its percent off the total (round to whole pence). An unknown code must throw a NotFoundError. test/features/coupon.test.js describes the behavior. Do not change the tests.",
    change: {
      "test/features/coupon.test.js": [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import { NotFoundError } from "../../src/core/errors.js";',
        'import { EventBus } from "../../src/core/events.js";',
        'import { CouponService } from "../../src/domains/coupon/service.js";',
        'import { OrderService } from "../../src/domains/order/service.js";',
        'import { ProductService } from "../../src/domains/product/service.js";',
        "",
        "function setup() {",
        "  const bus = new EventBus();",
        "  const products = new ProductService({ bus });",
        "  const coupons = new CouponService({ bus });",
        '  coupons.create({ code: "SAVE10", percent: 10 });',
        '  const lamp = products.create({ name: "lamp", price: 19.99 });',
        "  return { orders: new OrderService({ products, coupons, bus }), lamp };",
        "}",
        "",
        'test("a coupon takes its percent off", () => {',
        "  const { orders, lamp } = setup();",
        '  const order = orders.create({ customerId: "c1", couponCode: "SAVE10", lines: [{ productId: lamp.id, qty: 2 }] });',
        "  assert.equal(order.totalCents, 3598);",
        "});",
        "",
        'test("no coupon, full price", () => {',
        "  const { orders, lamp } = setup();",
        '  assert.equal(orders.create({ customerId: "c1", lines: [{ productId: lamp.id, qty: 2 }] }).totalCents, 3998);',
        "});",
        "",
        'test("an unknown code throws", () => {',
        "  const { orders, lamp } = setup();",
        "  assert.throws(",
        '    () => orders.create({ customerId: "c1", couponCode: "NOPE", lines: [{ productId: lamp.id, qty: 1 }] }),',
        "    NotFoundError,",
        "  );",
        "});",
        "",
      ].join("\n"),
    },
    check: "node --test",
    solution: {
      "src/domains/order/service.js": base("src/domains/order/service.js")
        .replace(
          "constructor({ products, repo = new OrderRepository(), bus = events } = {}) {\n    this.products = products;",
          "constructor({ products, coupons, repo = new OrderRepository(), bus = events } = {}) {\n    this.products = products;\n    this.coupons = coupons;",
        )
        .replace("create({ customerId, lines }) {", "create({ customerId, lines, couponCode }) {")
        .replace(
          "    const order = this.repo.add(",
          [
            "    if (couponCode !== undefined) {",
            "      const coupon = this.coupons?.all().find((c) => c.code === couponCode);",
            "      if (!coupon) throw new NotFoundError(`coupon ${couponCode}`);",
            "      totalCents = Math.round(totalCents * (1 - coupon.percent / 100));",
            "    }",
            "    const order = this.repo.add(",
          ].join("\n"),
        ),
    },
  }),
];
