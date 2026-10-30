import { lines, MAVEN_CHECK, MAVEN_POM, PYPROJECT, PYTEST_CHECK } from "./projects.js";
import type { EvalTask } from "./types.js";

/**
 * Held-out eval tasks (0.17, T11c; docs/lld/eval-evidence.md). They are never in the default run
 * (`--split heldout` or `all` selects them), and the tuning loop (T11d) never shows the proposer
 * anything from them. Each one is harder than the basic suite: the cause of a failure is in
 * another file than the symptom, a refactor spans modules, the agent writes tests that a mutation
 * check must find good enough, the repository's AGENTS.md sets conventions that a hidden test
 * checks, or the request is vague and the repository decides what it means.
 *
 * The TypeScript tasks run with Node's own type stripping (`node --test`, Node 22.18 or later), so
 * their code uses only erasable syntax: no parameter properties, enums or namespaces.
 *
 * Hidden tests: the check writes them after the run (into .check/), so the agent never sees them.
 * Mutation checks: the agent's tests must pass on the real code and fail on each mutant.
 *
 * Changing a task here changes its hash (report.ts): HELD_OUT_HASHES in the tests must change with
 * it, on purpose, and a tuning result seen before the change is invalid.
 */

const NODE_PKG = lines("{", '  "type": "module",', '  "private": true', "}");

/** Imports for a node:test file. */
const testHead = (...imports: string[]) =>
  lines(
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    ...imports,
  );

/**
 * A check that runs a hidden test file after the visible ones. The hidden file is written into
 * .check/ (after Garuda took the run's changed files, so it is not a change of the agent).
 */
const hiddenNode = (name: string, body: string, before = "") =>
  `${writeHidden(name, body)}${before}node --test "test/**/*.test.ts" .check/${name}`;

const hiddenPytest = (name: string, body: string, before = "") =>
  `${writeHidden(name, body)}${before}${PYTEST_CHECK} tests .check/${name}`;

/**
 * Write the hidden file first: the heredoc ends a line, so the command after it is a new list, and
 * `before` (a chain of `&&` tests) must be on the same line as the test command it guards.
 */
const writeHidden = (name: string, body: string) =>
  `mkdir -p .check && cat > .check/${name} <<'GARUDA_HIDDEN'\n${body}GARUDA_HIDDEN\n`;

/**
 * A mutation check: the agent's test command passes on the real code, then fails on each mutant.
 * Each mutant is a sed expression on one file, applied to a copy of the project.
 */
function mutationCheck(file: string, testCommand: string, mutants: string[]): string {
  const each = mutants
    .map(
      (m) =>
        `rm -rf "$d/p" && cp -R . "$d/p" && sed -i.orig ${shellWord(m)} "$d/p/${file}" && ! cmp -s "${file}" "$d/p/${file}" && (cd "$d/p" && ! ${testCommand} >/dev/null 2>&1)`,
    )
    .join(" && ");
  return `${testCommand} && d=$(mktemp -d) && ${each}`;
}

function shellWord(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// 1. Multi-file defect (TypeScript): the report is wrong; the causes are in convert and ledger.
const LEDGER_CONVERT_BUG = lines(
  'import { rate } from "./rates.ts";',
  "",
  "/** Convert an amount in minor units (pence, cents) from one currency to another. */",
  "export function convert(minor: number, from: string, to: string): number {",
  "  return (minor * rate(from)) / rate(to);",
  "}",
);
const LEDGER_TOTAL_BUG = lines(
  'import { convert } from "./convert.ts";',
  "",
  "export type Entry = { amountMinor: number; currency: string };",
  "",
  "/** The total of the entries in `currency`, in minor units. Round once, at the end. */",
  "export function total(entries: Entry[], currency: string): number {",
  "  let sum = 0;",
  "  for (const e of entries) sum += Math.round(convert(e.amountMinor, e.currency, currency));",
  "  return sum;",
  "}",
);

const ledger: EvalTask = {
  id: "ho-ledger",
  title: "Fix a ledger total across currencies",
  split: "heldout",
  prompt:
    "The ledger summary is wrong when entries are in other currencies. Fix the code so the tests in test/ pass. Do not change the tests.",
  files: {
    "package.json": NODE_PKG,
    "src/rates.ts": lines(
      "/** Units of each currency for 1 GBP. */",
      "export const RATES: Record<string, number> = { GBP: 1, EUR: 1.17, USD: 1.27 };",
      "",
      "export function rate(currency: string): number {",
      "  const r = RATES[currency];",
      '  if (r === undefined) throw new Error("unknown currency " + currency);',
      "  return r;",
      "}",
    ),
    "src/convert.ts": LEDGER_CONVERT_BUG,
    "src/ledger.ts": LEDGER_TOTAL_BUG,
    "src/report.ts": lines(
      'import { type Entry, total } from "./ledger.ts";',
      "",
      "export function summary(entries: Entry[], currency: string): string {",
      '  return currency + " " + (total(entries, currency) / 100).toFixed(2);',
      "}",
    ),
    "test/report.test.ts": testHead('import { summary } from "../src/report.ts";').concat(
      lines(
        'test("one entry in the same currency", () => {',
        '  assert.equal(summary([{ amountMinor: 1000, currency: "GBP" }], "GBP"), "GBP 10.00");',
        "});",
        'test("EUR to GBP", () => {',
        '  assert.equal(summary([{ amountMinor: 117, currency: "EUR" }], "GBP"), "GBP 1.00");',
        "});",
        'test("USD to EUR goes through GBP", () => {',
        '  assert.equal(summary([{ amountMinor: 127, currency: "USD" }], "EUR"), "EUR 1.17");',
        "});",
        'test("rounds once, at the end", () => {',
        '  const e = { amountMinor: 50, currency: "USD" };',
        '  assert.equal(summary([e, e, e], "GBP"), "GBP 1.18");',
        "});",
      ),
    ),
  },
  check: 'node --test "test/**/*.test.ts"',
  solution: {
    "src/convert.ts": LEDGER_CONVERT_BUG.replace(
      "  return (minor * rate(from)) / rate(to);",
      "  return (minor / rate(from)) * rate(to);",
    ),
    "src/ledger.ts": LEDGER_TOTAL_BUG.replace(
      "  for (const e of entries) sum += Math.round(convert(e.amountMinor, e.currency, currency));\n  return sum;",
      "  for (const e of entries) sum += convert(e.amountMinor, e.currency, currency);\n  return Math.round(sum);",
    ),
  },
};

// 2. Multi-file defect (Python): days.py counts Monday as 0, schedule.py mixes in isoweekday.
const SCHEDULE_BUG = lines(
  "from datetime import datetime, timedelta",
  "",
  "from .days import day_index",
  "",
  "",
  "def next_run(now: datetime, day: str, hour: int) -> datetime:",
  '    """The next time at hour:00 on `day` that is after `now`."""',
  "    target = day_index(day)",
  "    days_ahead = (target - now.isoweekday()) % 7",
  "    if days_ahead == 0 and now.hour > hour:",
  "        days_ahead = 7",
  "    run = now + timedelta(days=days_ahead)",
  "    return run.replace(hour=hour, minute=0, second=0, microsecond=0)",
);

const scheduler: EvalTask = {
  id: "ho-scheduler",
  title: "Fix the next run of a weekly schedule",
  split: "heldout",
  requires: ["pytest"],
  prompt:
    "next_run() picks the wrong day, and sometimes a time that has already passed. Fix it so the tests pass. Do not change the tests.",
  files: {
    "pyproject.toml": PYPROJECT,
    "src/sched/__init__.py": "",
    "src/sched/days.py": lines(
      'DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]',
      "",
      "",
      "def day_index(name: str) -> int:",
      '    """Monday is 0, Sunday is 6, as datetime.weekday() counts."""',
      "    return DAYS.index(name.strip().lower()[:3])",
    ),
    "src/sched/schedule.py": SCHEDULE_BUG,
    "tests/test_schedule.py": lines(
      "from datetime import datetime",
      "",
      "from sched.schedule import next_run",
      "",
      "WED_10 = datetime(2026, 10, 28, 10, 0)",
      "",
      "",
      "def test_later_this_week():",
      '    assert next_run(WED_10, "fri", 9) == datetime(2026, 10, 30, 9, 0)',
      "",
      "",
      "def test_same_day_already_passed():",
      '    assert next_run(WED_10, "wed", 9) == datetime(2026, 11, 4, 9, 0)',
      "",
      "",
      "def test_same_day_later():",
      '    assert next_run(datetime(2026, 10, 28, 8, 0), "wed", 9) == datetime(2026, 10, 28, 9, 0)',
      "",
      "",
      "def test_inside_the_hour_is_passed():",
      '    assert next_run(datetime(2026, 10, 28, 9, 30), "Wednesday", 9) == datetime(2026, 11, 4, 9, 0)',
      "",
      "",
      "def test_next_monday():",
      '    assert next_run(WED_10, "Monday", 7) == datetime(2026, 11, 2, 7, 0)',
    ),
  },
  check: PYTEST_CHECK,
  solution: {
    "src/sched/schedule.py": SCHEDULE_BUG.replace(
      "    days_ahead = (target - now.isoweekday()) % 7\n    if days_ahead == 0 and now.hour > hour:",
      "    days_ahead = (target - now.weekday()) % 7\n    if days_ahead == 0 and now >= now.replace(hour=hour, minute=0, second=0, microsecond=0):",
    ),
  },
};

// 3. Multi-file defect (Java): Sku has no equals/hashCode, and release() returns stock twice.
const SKU_BUG = lines(
  "package inv;",
  "",
  "public final class Sku {",
  "  private final String code;",
  "  private final String size;",
  "",
  "  public Sku(String code, String size) {",
  "    this.code = code;",
  "    this.size = size;",
  "  }",
  "",
  "  public String code() {",
  "    return code;",
  "  }",
  "",
  "  public String size() {",
  "    return size;",
  "  }",
  "}",
);
const RESERVATIONS_BUG = lines(
  "package inv;",
  "",
  "import java.util.HashMap;",
  "import java.util.Map;",
  "",
  "public final class Reservations {",
  "  private final Stock stock;",
  "  private final Map<Sku, Integer> held = new HashMap<>();",
  "",
  "  public Reservations(Stock stock) {",
  "    this.stock = stock;",
  "  }",
  "",
  "  /** Hold n units of the SKU. False when fewer are available. */",
  "  public boolean reserve(Sku sku, int n) {",
  "    if (stock.available(sku) < n) {",
  "      return false;",
  "    }",
  "    stock.add(sku, -n);",
  "    held.merge(sku, n, Integer::sum);",
  "    return true;",
  "  }",
  "",
  "  /** Give the held units of the SKU back to the stock. */",
  "  public void release(Sku sku) {",
  "    Integer n = held.get(sku);",
  "    if (n != null) {",
  "      stock.add(sku, n);",
  "    }",
  "  }",
  "",
  "  public int held(Sku sku) {",
  "    return held.getOrDefault(sku, 0);",
  "  }",
  "}",
);

const inventory: EvalTask = {
  id: "ho-inventory",
  title: "Fix lost and doubled stock in reservations",
  split: "heldout",
  requires: ["maven"],
  prompt:
    "Reservations lose track of stock, and releasing can give stock back twice. Fix the code so the tests pass. Do not change the tests.",
  files: {
    "pom.xml": MAVEN_POM,
    "src/main/java/inv/Sku.java": SKU_BUG,
    "src/main/java/inv/Stock.java": lines(
      "package inv;",
      "",
      "import java.util.HashMap;",
      "import java.util.Map;",
      "",
      "public final class Stock {",
      "  private final Map<Sku, Integer> counts = new HashMap<>();",
      "",
      "  public void add(Sku sku, int n) {",
      "    counts.merge(sku, n, Integer::sum);",
      "  }",
      "",
      "  public int available(Sku sku) {",
      "    return counts.getOrDefault(sku, 0);",
      "  }",
      "}",
    ),
    "src/main/java/inv/Reservations.java": RESERVATIONS_BUG,
    "src/test/java/inv/ReservationsTest.java": lines(
      "package inv;",
      "",
      "import static org.junit.jupiter.api.Assertions.assertEquals;",
      "import static org.junit.jupiter.api.Assertions.assertFalse;",
      "import static org.junit.jupiter.api.Assertions.assertTrue;",
      "",
      "import org.junit.jupiter.api.Test;",
      "",
      "class ReservationsTest {",
      "  @Test",
      "  void reservesWithAnEqualSku() {",
      "    Stock stock = new Stock();",
      '    stock.add(new Sku("shirt", "M"), 5);',
      "    Reservations r = new Reservations(stock);",
      '    assertTrue(r.reserve(new Sku("shirt", "M"), 3));',
      '    assertEquals(2, stock.available(new Sku("shirt", "M")));',
      '    assertEquals(3, r.held(new Sku("shirt", "M")));',
      "  }",
      "",
      "  @Test",
      "  void refusesMoreThanAvailable() {",
      "    Stock stock = new Stock();",
      '    stock.add(new Sku("shirt", "L"), 1);',
      '    assertFalse(new Reservations(stock).reserve(new Sku("shirt", "L"), 2));',
      "  }",
      "",
      "  @Test",
      "  void releaseGivesStockBackOnce() {",
      "    Stock stock = new Stock();",
      '    Sku sku = new Sku("cap", "S");',
      "    stock.add(sku, 4);",
      "    Reservations r = new Reservations(stock);",
      "    r.reserve(sku, 3);",
      "    r.release(sku);",
      "    r.release(sku);",
      "    assertEquals(4, stock.available(sku));",
      "    assertEquals(0, r.held(sku));",
      "  }",
      "}",
    ),
  },
  check: MAVEN_CHECK,
  solution: {
    "src/main/java/inv/Sku.java": SKU_BUG.replace(
      "  public String size() {\n    return size;\n  }\n}",
      [
        "  public String size() {",
        "    return size;",
        "  }",
        "",
        "  @Override",
        "  public boolean equals(Object o) {",
        "    return o instanceof Sku other && code.equals(other.code) && size.equals(other.size);",
        "  }",
        "",
        "  @Override",
        "  public int hashCode() {",
        "    return java.util.Objects.hash(code, size);",
        "  }",
        "}",
      ].join("\n"),
    ),
    "src/main/java/inv/Reservations.java": RESERVATIONS_BUG.replace(
      "    Integer n = held.get(sku);",
      "    Integer n = held.remove(sku);",
    ),
  },
};

// 4. Cross-module refactor (TypeScript): rename an option, keep the old name with a warning.
const OPTIONS_SRC = lines(
  "export type Options = { url: string; timeoutMs: number; retries: number };",
  "",
  "export function parseOptions(raw: Record<string, unknown>, onWarning: (text: string) => void = () => {}): Options {",
  '  if (typeof raw.url !== "string") throw new Error("url is required");',
  "  void onWarning;",
  "  return {",
  "    url: raw.url,",
  '    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 5000,',
  '    retries: typeof raw.retries === "number" ? raw.retries : 2,',
  "  };",
  "}",
);
const CLIENT_SRC = lines(
  'import type { Options } from "./options.ts";',
  "",
  "export type Fetcher = (url: string, init: { deadlineMs: number }) => Promise<string>;",
  "",
  "export async function request(options: Options, fetcher: Fetcher): Promise<string> {",
  "  let last: unknown;",
  "  for (let i = 0; i <= options.retries; i++) {",
  "    try {",
  "      return await fetcher(options.url, { deadlineMs: options.timeoutMs });",
  "    } catch (error) {",
  "      last = error;",
  "    }",
  "  }",
  "  throw last;",
  "}",
);
const CLI_SRC = lines(
  'import { type Options, parseOptions } from "./options.ts";',
  "",
  "export function optionsFromArgs(args: string[], onWarning?: (text: string) => void): Options {",
  "  const raw: Record<string, unknown> = {};",
  "  for (let i = 0; i < args.length; i += 2) {",
  "    const flag = args[i];",
  "    const value = args[i + 1];",
  '    if (flag === "--url") raw.url = value;',
  '    if (flag === "--timeout-ms") raw.timeoutMs = Number(value);',
  '    if (flag === "--retries") raw.retries = Number(value);',
  "  }",
  "  return parseOptions(raw, onWarning);",
  "}",
);

const renameOption: EvalTask = {
  id: "ho-rename-option",
  title: "Rename an option across modules, with a deprecation path",
  split: "heldout",
  prompt:
    'Rename the option timeoutMs to deadlineMs everywhere: the Options type, the client and the CLI flag (--deadline-ms). Old configs still use timeoutMs: keep accepting it, and report it through onWarning with the text "timeoutMs is deprecated; use deadlineMs". The tests in test/ show the new API. Do not change the tests.',
  files: {
    "package.json": NODE_PKG,
    "src/options.ts": OPTIONS_SRC,
    "src/client.ts": CLIENT_SRC,
    "src/cli.ts": CLI_SRC,
    "test/options.test.ts": testHead(
      'import { optionsFromArgs } from "../src/cli.ts";',
      'import { request } from "../src/client.ts";',
      'import { parseOptions } from "../src/options.ts";',
    ).concat(
      lines(
        'test("the new name", () => {',
        '  const o = parseOptions({ url: "u", deadlineMs: 500 });',
        "  assert.equal(o.deadlineMs, 500);",
        '  assert.equal("timeoutMs" in o, false);',
        "});",
        'test("the old name still works, with a warning", () => {',
        "  const warnings: string[] = [];",
        '  const o = parseOptions({ url: "u", timeoutMs: 300 }, (w) => warnings.push(w));',
        "  assert.equal(o.deadlineMs, 300);",
        '  assert.deepEqual(warnings, ["timeoutMs is deprecated; use deadlineMs"]);',
        "});",
        'test("the default", () => assert.equal(parseOptions({ url: "u" }).deadlineMs, 5000));',
        'test("the client sends the deadline", async () => {',
        "  const seen: number[] = [];",
        '  await request(parseOptions({ url: "u", deadlineMs: 250 }), async (_u, init) => {',
        "    seen.push(init.deadlineMs);",
        '    return "ok";',
        "  });",
        "  assert.deepEqual(seen, [250]);",
        "});",
        'test("the CLI flag", () => {',
        '  assert.equal(optionsFromArgs(["--url", "u", "--deadline-ms", "750"]).deadlineMs, 750);',
        "});",
      ),
    ),
  },
  check:
    'node --test "test/**/*.test.ts" && ! grep -q timeoutMs src/client.ts src/cli.ts && grep -q "deadline-ms" src/cli.ts',
  solution: {
    "src/options.ts": lines(
      "export type Options = { url: string; deadlineMs: number; retries: number };",
      "",
      "export function parseOptions(raw: Record<string, unknown>, onWarning: (text: string) => void = () => {}): Options {",
      '  if (typeof raw.url !== "string") throw new Error("url is required");',
      "  let deadline = raw.deadlineMs;",
      '  if (deadline === undefined && typeof raw.timeoutMs === "number") {',
      '    onWarning("timeoutMs is deprecated; use deadlineMs");',
      "    deadline = raw.timeoutMs;",
      "  }",
      "  return {",
      "    url: raw.url,",
      '    deadlineMs: typeof deadline === "number" ? deadline : 5000,',
      '    retries: typeof raw.retries === "number" ? raw.retries : 2,',
      "  };",
      "}",
    ),
    "src/client.ts": CLIENT_SRC.replace(
      "{ deadlineMs: options.timeoutMs }",
      "{ deadlineMs: options.deadlineMs }",
    ),
    "src/cli.ts": CLI_SRC.replace(
      '    if (flag === "--timeout-ms") raw.timeoutMs = Number(value);',
      '    if (flag === "--deadline-ms") raw.deadlineMs = Number(value);',
    ),
  },
};

// 5. Cross-module refactor (Java): extract Notifier; SmsNotifier names its method differently.
const ORDER_SERVICE = lines(
  "package shop;",
  "",
  "public final class OrderService {",
  "  private final EmailNotifier notifier;",
  "",
  "  public OrderService(EmailNotifier notifier) {",
  "    this.notifier = notifier;",
  "  }",
  "",
  "  public void placeOrder(String customer, String item) {",
  '    notifier.send(customer, "Order placed: " + item);',
  "  }",
  "}",
);
const REMINDER_SERVICE = lines(
  "package shop;",
  "",
  "public final class ReminderService {",
  "  private final SmsNotifier sms;",
  "",
  "  public ReminderService(SmsNotifier sms) {",
  "    this.sms = sms;",
  "  }",
  "",
  "  public void remind(String phone, String what) {",
  '    sms.deliver(phone, "Reminder: " + what);',
  "  }",
  "}",
);
const EMAIL_NOTIFIER = lines(
  "package shop;",
  "",
  "import java.util.ArrayList;",
  "import java.util.List;",
  "",
  "public class EmailNotifier {",
  "  private final List<String> outbox = new ArrayList<>();",
  "",
  "  public void send(String to, String text) {",
  '    outbox.add("mail " + to + ": " + text);',
  "  }",
  "",
  "  public List<String> outbox() {",
  "    return outbox;",
  "  }",
  "}",
);
const SMS_NOTIFIER = lines(
  "package shop;",
  "",
  "import java.util.ArrayList;",
  "import java.util.List;",
  "",
  "public class SmsNotifier {",
  "  private final List<String> sent = new ArrayList<>();",
  "",
  "  public void deliver(String phone, String text) {",
  '    sent.add("sms " + phone + ": " + text);',
  "  }",
  "",
  "  public List<String> sent() {",
  "    return sent;",
  "  }",
  "}",
);

const extractInterface: EvalTask = {
  id: "ho-notifier",
  title: "Extract an interface that two classes implement",
  split: "heldout",
  requires: ["maven"],
  prompt:
    "The services must accept any notifier, so tests can pass a fake. Extract a Notifier interface with send(String to, String text), make EmailNotifier and SmsNotifier implement it, and make OrderService and ReminderService depend on Notifier. The tests show the API. Do not change the tests.",
  files: {
    "pom.xml": MAVEN_POM,
    "src/main/java/shop/EmailNotifier.java": EMAIL_NOTIFIER,
    "src/main/java/shop/SmsNotifier.java": SMS_NOTIFIER,
    "src/main/java/shop/OrderService.java": ORDER_SERVICE,
    "src/main/java/shop/ReminderService.java": REMINDER_SERVICE,
    "src/test/java/shop/ServicesTest.java": lines(
      "package shop;",
      "",
      "import static org.junit.jupiter.api.Assertions.assertEquals;",
      "",
      "import java.util.ArrayList;",
      "import java.util.List;",
      "import org.junit.jupiter.api.Test;",
      "",
      "class ServicesTest {",
      "  static final class FakeNotifier implements Notifier {",
      "    final List<String> sent = new ArrayList<>();",
      "",
      "    @Override",
      "    public void send(String to, String text) {",
      '      sent.add(to + "|" + text);',
      "    }",
      "  }",
      "",
      "  @Test",
      "  void ordersUseAnyNotifier() {",
      "    FakeNotifier fake = new FakeNotifier();",
      '    new OrderService(fake).placeOrder("ann@example.com", "lamp");',
      '    assertEquals(List.of("ann@example.com|Order placed: lamp"), fake.sent);',
      "  }",
      "",
      "  @Test",
      "  void remindersUseAnyNotifier() {",
      "    FakeNotifier fake = new FakeNotifier();",
      '    new ReminderService(fake).remind("+44 1", "dentist");',
      '    assertEquals(List.of("+44 1|Reminder: dentist"), fake.sent);',
      "  }",
      "",
      "  @Test",
      "  void bothRealNotifiersAreNotifiers() {",
      "    SmsNotifier sms = new SmsNotifier();",
      "    Notifier n = sms;",
      '    n.send("+44 2", "hi");',
      '    assertEquals(List.of("sms +44 2: hi"), sms.sent());',
      "    EmailNotifier mail = new EmailNotifier();",
      '    new OrderService(mail).placeOrder("bob@example.com", "desk");',
      '    assertEquals(List.of("mail bob@example.com: Order placed: desk"), mail.outbox());',
      "  }",
      "}",
    ),
  },
  check: MAVEN_CHECK,
  solution: {
    "src/main/java/shop/Notifier.java": lines(
      "package shop;",
      "",
      "public interface Notifier {",
      "  void send(String to, String text);",
      "}",
    ),
    "src/main/java/shop/EmailNotifier.java": EMAIL_NOTIFIER.replace(
      "public class EmailNotifier {",
      "public class EmailNotifier implements Notifier {",
    ).replace("  public void send(", "  @Override\n  public void send("),
    "src/main/java/shop/SmsNotifier.java": SMS_NOTIFIER.replace(
      "public class SmsNotifier {",
      "public class SmsNotifier implements Notifier {",
    ).replace(
      "  public void deliver(String phone, String text) {",
      "  @Override\n  public void send(String phone, String text) {",
    ),
    "src/main/java/shop/OrderService.java": ORDER_SERVICE.replaceAll("EmailNotifier", "Notifier"),
    "src/main/java/shop/ReminderService.java": REMINDER_SERVICE.replaceAll(
      "SmsNotifier sms",
      "Notifier sms",
    ).replace("sms.deliver(", "sms.send("),
  },
};

// 6. Missing tests (Python): tests for a duration parser, checked against mutants.
const PARSE_PY = lines(
  "import re",
  "",
  'PART = re.compile(r"(\\d+)([hms])")',
  'ORDER = "hms"',
  "",
  "",
  "def parse_duration(text: str) -> int:",
  '    """Seconds in a duration such as "1h30m", "90s" or "2h 5s".',
  "",
  "    Units h, m and s, each at most once, in that order. Spaces are allowed between parts.",
  "    Raises ValueError for anything else.",
  '    """',
  "    text = text.strip()",
  "    if not text:",
  '        raise ValueError("empty duration")',
  "    seconds = 0",
  "    pos = 0",
  "    last = -1",
  "    for match in PART.finditer(text):",
  '        if text[pos:match.start()].strip() != "":',
  '            raise ValueError(f"bad part in {text!r}")',
  "        number, unit = int(match.group(1)), match.group(2)",
  "        index = ORDER.index(unit)",
  "        if index <= last:",
  '            raise ValueError(f"unit {unit} out of order in {text!r}")',
  "        last = index",
  '        seconds += number * {"h": 3600, "m": 60, "s": 1}[unit]',
  "        pos = match.end()",
  "    if pos != len(text) or last == -1:",
  '        raise ValueError(f"bad duration {text!r}")',
  "    return seconds",
);

const testsParser: EvalTask = {
  id: "ho-tests-duration",
  title: "Write tests that catch real bugs in a parser",
  split: "heldout",
  requires: ["pytest"],
  prompt:
    "Write tests for parse_duration in src/durations/parse.py, in tests/test_parse.py, with pytest. Cover the valid forms and every kind of error that the docstring describes. Run them. Do not change the parser.",
  files: {
    "pyproject.toml": PYPROJECT,
    "src/durations/__init__.py": "",
    "src/durations/parse.py": PARSE_PY,
  },
  protect: ["src/durations/parse.py", "pyproject.toml"],
  check: `test -f tests/test_parse.py && ${mutationCheck(
    "src/durations/parse.py",
    `${PYTEST_CHECK} tests/test_parse.py`,
    [
      's/"h": 3600/"h": 60/',
      "s/if index <= last:/if index < last:/",
      "s/if pos != len(text) or last == -1:/if last == -1:/",
    ],
  )}`,
  solution: {
    "tests/test_parse.py": lines(
      "import pytest",
      "",
      "from durations.parse import parse_duration",
      "",
      "",
      '@pytest.mark.parametrize("text, seconds", [("1h30m", 5400), ("90s", 90), ("2h 5s", 7205), (" 3m ", 180)])',
      "def test_valid(text, seconds):",
      "    assert parse_duration(text) == seconds",
      "",
      "",
      '@pytest.mark.parametrize("text", ["", "   ", "1x", "m", "1h1h", "1m1h", "1h junk", "5"])',
      "def test_errors(text):",
      "    with pytest.raises(ValueError):",
      "        parse_duration(text)",
    ),
  },
};

// 7. Missing tests (TypeScript): tests for a token bucket with an injected clock.
const LIMITER_TS = lines(
  "/** A token bucket. The clock gives milliseconds; tests pass their own. */",
  "export class TokenBucket {",
  "  private readonly capacity: number;",
  "  private readonly refillPerSec: number;",
  "  private readonly clock: () => number;",
  "  private tokens: number;",
  "  private last: number;",
  "",
  "  constructor(capacity: number, refillPerSec: number, clock: () => number = Date.now) {",
  "    this.capacity = capacity;",
  "    this.refillPerSec = refillPerSec;",
  "    this.clock = clock;",
  "    this.tokens = capacity;",
  "    this.last = clock();",
  "  }",
  "",
  "  /** Take n tokens when there are enough; otherwise take none and return false. */",
  "  tryTake(n = 1): boolean {",
  "    const now = this.clock();",
  "    const elapsedMs = now - this.last;",
  "    this.last = now;",
  "    const gained = (elapsedMs / 1000) * this.refillPerSec;",
  "    this.tokens = Math.min(this.capacity, this.tokens + gained);",
  "    if (this.tokens < n) return false;",
  "    this.tokens -= n;",
  "    return true;",
  "  }",
  "}",
);

const testsLimiter: EvalTask = {
  id: "ho-tests-limiter",
  title: "Write tests for a rate limiter with a fake clock",
  split: "heldout",
  prompt:
    "Write tests for src/limiter.ts in test/limiter.test.ts with node:test. Use the clock parameter, not real time. Cover the refill rate, the capacity cap, and taking more tokens than are left. Run them. Do not change the limiter.",
  files: {
    "package.json": NODE_PKG,
    "src/limiter.ts": LIMITER_TS,
  },
  protect: ["src/limiter.ts", "package.json"],
  check: `test -f test/limiter.test.ts && ${mutationCheck(
    "src/limiter.ts",
    "node --test test/limiter.test.ts",
    [
      "s/Math.min(this.capacity, this.tokens + gained)/this.tokens + gained/",
      "s#(elapsedMs / 1000) \\* this.refillPerSec#elapsedMs * this.refillPerSec#",
      "s/if (this.tokens < n) return false;/if (this.tokens < 1) return false;/",
    ],
  )}`,
  solution: {
    "test/limiter.test.ts": testHead('import { TokenBucket } from "../src/limiter.ts";').concat(
      lines(
        'test("starts full and takes", () => {',
        "  let now = 0;",
        "  const b = new TokenBucket(3, 1, () => now);",
        "  assert.equal(b.tryTake(3), true);",
        "  assert.equal(b.tryTake(1), false);",
        "});",
        'test("refills at the rate", () => {',
        "  let now = 0;",
        "  const b = new TokenBucket(5, 2, () => now);",
        "  b.tryTake(5);",
        "  now = 1000;",
        "  assert.equal(b.tryTake(2), true);",
        "  assert.equal(b.tryTake(1), false);",
        "});",
        'test("never holds more than the capacity", () => {',
        "  let now = 0;",
        "  const b = new TokenBucket(2, 10, () => now);",
        "  now = 60_000;",
        "  assert.equal(b.tryTake(2), true);",
        "  assert.equal(b.tryTake(1), false);",
        "});",
        'test("asking for more than is left takes nothing", () => {',
        "  let now = 0;",
        "  const b = new TokenBucket(4, 1, () => now);",
        "  b.tryTake(2);",
        "  assert.equal(b.tryTake(3), false);",
        "  assert.equal(b.tryTake(2), true);",
        "});",
      ),
    ),
  },
};

// 8. Repository conventions (TypeScript): AGENTS.md says how handlers look; a hidden test checks.
const routesSrc = (extra: string[] = []) =>
  lines(
    'import type { Handler } from "./types.ts";',
    'import { handle as createTodo } from "./handlers/createTodo.ts";',
    'import { handle as getTodo } from "./handlers/getTodo.ts";',
    ...extra.filter((l) => l.startsWith("import")),
    "",
    "export const routes: Record<string, Handler> = {",
    '  "GET /todos/:id": getTodo,',
    '  "POST /todos": createTodo,',
    ...extra.filter((l) => !l.startsWith("import")),
    "};",
  );

const conventionsHandler: EvalTask = {
  id: "ho-conventions-handler",
  title: "Add a handler the way this repository does it",
  split: "heldout",
  prompt: "Add a handler to delete a todo: DELETE /todos/:id.",
  files: {
    "package.json": NODE_PKG,
    "AGENTS.md": lines(
      "# Conventions",
      "",
      "- A handler lives in src/handlers/<name>.ts and exports `handle(req, deps)`.",
      "- Handlers never throw. They return a Result from src/result.ts: `ok(value)` or `err(AppError)`.",
      "- Errors are `AppError` from src/errors.ts, with a code: NOT_FOUND, INVALID or CONFLICT.",
      '- Register every handler in src/routes.ts, as `"<METHOD> <path>"`.',
      "- Every handler has a test in test/handlers/<name>.test.ts.",
      "- Run the tests with: node --test",
    ),
    "src/result.ts": lines(
      'import type { AppError } from "./errors.ts";',
      "",
      "export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };",
      "export const ok = <T>(value: T): Result<T> => ({ ok: true, value });",
      "export const err = <T>(error: AppError): Result<T> => ({ ok: false, error });",
    ),
    "src/errors.ts": lines(
      'export type ErrorCode = "NOT_FOUND" | "INVALID" | "CONFLICT";',
      "",
      "export class AppError {",
      "  readonly code: ErrorCode;",
      "  readonly message: string;",
      "  constructor(code: ErrorCode, message: string) {",
      "    this.code = code;",
      "    this.message = message;",
      "  }",
      "}",
    ),
    "src/store.ts": lines(
      "export type Todo = { id: string; title: string; done: boolean };",
      "",
      "export class TodoStore {",
      "  private readonly todos = new Map<string, Todo>();",
      "  private next = 1;",
      "",
      "  add(title: string): Todo {",
      "    const todo = { id: String(this.next++), title, done: false };",
      "    this.todos.set(todo.id, todo);",
      "    return todo;",
      "  }",
      "",
      "  get(id: string): Todo | undefined {",
      "    return this.todos.get(id);",
      "  }",
      "",
      "  remove(id: string): boolean {",
      "    return this.todos.delete(id);",
      "  }",
      "}",
    ),
    "src/types.ts": lines(
      'import type { Result } from "./result.ts";',
      'import type { TodoStore } from "./store.ts";',
      "",
      "export type Request = { params: Record<string, string>; body?: Record<string, unknown> };",
      "export type Deps = { store: TodoStore };",
      "export type Handler = (req: Request, deps: Deps) => Result<unknown>;",
    ),
    "src/handlers/getTodo.ts": lines(
      'import { AppError } from "../errors.ts";',
      'import { err, ok, type Result } from "../result.ts";',
      'import type { Todo } from "../store.ts";',
      'import type { Deps, Request } from "../types.ts";',
      "",
      "export function handle(req: Request, deps: Deps): Result<Todo> {",
      "  const id = req.params.id;",
      '  if (!id) return err(new AppError("INVALID", "id is required"));',
      "  const todo = deps.store.get(id);",
      '  if (todo === undefined) return err(new AppError("NOT_FOUND", "no todo " + id));',
      "  return ok(todo);",
      "}",
    ),
    "src/handlers/createTodo.ts": lines(
      'import { AppError } from "../errors.ts";',
      'import { err, ok, type Result } from "../result.ts";',
      'import type { Todo } from "../store.ts";',
      'import type { Deps, Request } from "../types.ts";',
      "",
      "export function handle(req: Request, deps: Deps): Result<Todo> {",
      "  const title = req.body?.title;",
      '  if (typeof title !== "string" || title.trim() === "") {',
      '    return err(new AppError("INVALID", "title is required"));',
      "  }",
      "  return ok(deps.store.add(title.trim()));",
      "}",
    ),
    "src/routes.ts": routesSrc(),
    "test/handlers/getTodo.test.ts": testHead(
      'import { handle } from "../../src/handlers/getTodo.ts";',
      'import { TodoStore } from "../../src/store.ts";',
    ).concat(
      lines(
        'test("finds a todo", () => {',
        "  const store = new TodoStore();",
        '  const todo = store.add("milk");',
        "  assert.deepEqual(handle({ params: { id: todo.id } }, { store }), { ok: true, value: todo });",
        "});",
        'test("an unknown id is NOT_FOUND", () => {',
        '  const r = handle({ params: { id: "9" } }, { store: new TodoStore() });',
        '  assert.equal(r.ok === false && r.error.code, "NOT_FOUND");',
        "});",
      ),
    ),
  },
  check: hiddenNode(
    "deleteTodo.hidden.test.ts",
    testHead(
      'import { routes } from "../src/routes.ts";',
      'import { TodoStore } from "../src/store.ts";',
    ).concat(
      lines(
        'const del = routes["DELETE /todos/:id"];',
        'test("registered in routes", () => assert.equal(typeof del, "function"));',
        'test("deletes a todo and returns ok", () => {',
        "  const store = new TodoStore();",
        '  const todo = store.add("bread");',
        "  const r = del({ params: { id: todo.id } }, { store });",
        "  assert.equal(r.ok, true);",
        "  assert.equal(store.get(todo.id), undefined);",
        "});",
        'test("an unknown id is a NOT_FOUND result, not an exception", () => {',
        '  const r = del({ params: { id: "42" } }, { store: new TodoStore() });',
        '  assert.equal(r.ok === false && r.error.code, "NOT_FOUND");',
        "});",
        'test("an empty id is INVALID", () => {',
        '  const r = del({ params: { id: "" } }, { store: new TodoStore() });',
        '  assert.equal(r.ok === false && r.error.code, "INVALID");',
        "});",
      ),
    ),
    "test -f src/handlers/deleteTodo.ts && test -f test/handlers/deleteTodo.test.ts && ",
  ),
  solution: {
    "src/handlers/deleteTodo.ts": lines(
      'import { AppError } from "../errors.ts";',
      'import { err, ok, type Result } from "../result.ts";',
      'import type { Deps, Request } from "../types.ts";',
      "",
      "export function handle(req: Request, deps: Deps): Result<{ id: string }> {",
      "  const id = req.params.id;",
      '  if (!id) return err(new AppError("INVALID", "id is required"));',
      '  if (!deps.store.remove(id)) return err(new AppError("NOT_FOUND", "no todo " + id));',
      "  return ok({ id });",
      "}",
    ),
    "src/routes.ts": routesSrc([
      'import { handle as deleteTodo } from "./handlers/deleteTodo.ts";',
      '  "DELETE /todos/:id": deleteTodo,',
    ]),
    "test/handlers/deleteTodo.test.ts": testHead(
      'import { handle } from "../../src/handlers/deleteTodo.ts";',
      'import { TodoStore } from "../../src/store.ts";',
    ).concat(
      lines(
        'test("deletes", () => {',
        "  const store = new TodoStore();",
        '  const todo = store.add("x");',
        "  assert.equal(handle({ params: { id: todo.id } }, { store }).ok, true);",
        "});",
      ),
    ),
  },
};

// 9. Repository conventions (Python): a CLI command that follows AGENTS.md; a hidden test checks.
const REGISTRY_PY = lines(
  "from .commands import add, list_cmd",
  "",
  "COMMANDS = {",
  '    "add": add.run,',
  '    "list": list_cmd.run,',
  "}",
);

const conventionsCli: EvalTask = {
  id: "ho-conventions-cli",
  title: "Add a CLI command the way this repository does it",
  split: "heldout",
  requires: ["pytest"],
  prompt: "Add a stats command that shows how many items are done and how many are open.",
  files: {
    "pyproject.toml": PYPROJECT,
    "AGENTS.md": lines(
      "# Conventions",
      "",
      "- Each command is a module in src/todo_cli/commands/<name>.py with `def run(args, ctx) -> int`.",
      "- Register every command in COMMANDS in src/todo_cli/registry.py.",
      "- Never print. Write output with `ctx.out.write(...)`. With `ctx.json`, write one JSON object.",
      "- Read items only through `ctx.store.items()`.",
      "- Test with: python3 -m pytest",
    ),
    "src/todo_cli/__init__.py": "",
    "src/todo_cli/commands/__init__.py": "",
    "src/todo_cli/context.py": lines(
      "from dataclasses import dataclass",
      "from typing import TextIO",
      "",
      "from .store import Store",
      "",
      "",
      "@dataclass",
      "class Context:",
      "    out: TextIO",
      "    store: Store",
      "    json: bool = False",
    ),
    "src/todo_cli/store.py": lines(
      "class Store:",
      "    def __init__(self, items=None):",
      "        self._items = list(items or [])",
      "",
      "    def items(self):",
      "        return list(self._items)",
      "",
      "    def add(self, title):",
      '        self._items.append({"title": title, "done": False})',
    ),
    "src/todo_cli/commands/list_cmd.py": lines(
      "import json",
      "",
      "",
      "def run(args, ctx) -> int:",
      "    items = ctx.store.items()",
      "    if ctx.json:",
      '        ctx.out.write(json.dumps({"items": items}) + "\\n")',
      "        return 0",
      "    for item in items:",
      '        mark = "x" if item["done"] else " "',
      "        ctx.out.write(f\"[{mark}] {item['title']}\\n\")",
      "    return 0",
    ),
    "src/todo_cli/commands/add.py": lines(
      "def run(args, ctx) -> int:",
      "    if not args:",
      '        ctx.out.write("usage: add <title>\\n")',
      "        return 2",
      '    ctx.store.add(" ".join(args))',
      "    return 0",
    ),
    "src/todo_cli/registry.py": REGISTRY_PY,
    "tests/test_list.py": lines(
      "import io",
      "import json",
      "",
      "from todo_cli.context import Context",
      "from todo_cli.registry import COMMANDS",
      "from todo_cli.store import Store",
      "",
      "",
      "def test_list_json():",
      "    out = io.StringIO()",
      '    ctx = Context(out=out, store=Store([{"title": "a", "done": True}]), json=True)',
      '    assert COMMANDS["list"]([], ctx) == 0',
      '    assert json.loads(out.getvalue()) == {"items": [{"title": "a", "done": True}]}',
    ),
  },
  check: hiddenPytest(
    "test_stats_hidden.py",
    lines(
      "import io",
      "import json",
      "",
      "from todo_cli.context import Context",
      "from todo_cli.registry import COMMANDS",
      "from todo_cli.store import Store",
      "",
      'ITEMS = [{"title": "a", "done": True}, {"title": "b", "done": True}, {"title": "c", "done": False}]',
      "",
      "",
      "def run(as_json):",
      "    out = io.StringIO()",
      '    code = COMMANDS["stats"]([], Context(out=out, store=Store(ITEMS), json=as_json))',
      "    return code, out.getvalue()",
      "",
      "",
      "def test_registered():",
      '    assert "stats" in COMMANDS',
      "",
      "",
      "def test_json_is_one_object():",
      "    code, text = run(True)",
      "    assert code == 0",
      '    assert json.loads(text) == {"done": 2, "open": 1}',
      "",
      "",
      "def test_text():",
      "    code, text = run(False)",
      "    assert code == 0",
      '    assert "2" in text and "1" in text and "done" in text and "open" in text',
    ),
    '! grep -q "print(" src/todo_cli/commands/stats.py && ',
  ),
  solution: {
    "src/todo_cli/commands/stats.py": lines(
      "import json",
      "",
      "",
      "def run(args, ctx) -> int:",
      "    items = ctx.store.items()",
      '    done = sum(1 for item in items if item["done"])',
      '    counts = {"done": done, "open": len(items) - done}',
      "    if ctx.json:",
      '        ctx.out.write(json.dumps(counts) + "\\n")',
      "    else:",
      "        ctx.out.write(f\"{counts['done']} done, {counts['open']} open\\n\")",
      "    return 0",
    ),
    "src/todo_cli/registry.py": REGISTRY_PY.replace(
      "from .commands import add, list_cmd",
      "from .commands import add, list_cmd, stats",
    ).replace(
      '    "list": list_cmd.run,\n',
      '    "list": list_cmd.run,\n    "stats": stats.run,\n',
    ),
  },
};

// 10. Ambiguous request (TypeScript): which date format? Two exporters and a helper say ISO.
const CSV_BUG = lines(
  'import type { Row } from "../types.ts";',
  "",
  "export function toCsv(rows: Row[]): string {",
  '  const lines = ["name,amount,date"];',
  "  for (const r of rows) {",
  '    lines.push([r.name, r.amount.toFixed(2), r.date.toLocaleDateString("en-US")].join(","));',
  "  }",
  '  return lines.join("\\n") + "\\n";',
  "}",
);

const ambiguousDates: EvalTask = {
  id: "ho-export-dates",
  title: "Resolve a vague request from the repository",
  split: "heldout",
  prompt: "Users say the dates in our exports are inconsistent. Fix it.",
  files: {
    "package.json": NODE_PKG,
    "src/types.ts": lines("export type Row = { name: string; amount: number; date: Date };"),
    "src/format.ts": lines(
      "/** The date as YYYY-MM-DD, in UTC: the format of every export. */",
      "export function isoDate(d: Date): string {",
      "  return d.toISOString().slice(0, 10);",
      "}",
    ),
    "src/export/json.ts": lines(
      'import { isoDate } from "../format.ts";',
      'import type { Row } from "../types.ts";',
      "",
      "export function toJson(rows: Row[]): string {",
      "  return JSON.stringify(rows.map((r) => ({ ...r, date: isoDate(r.date) })));",
      "}",
    ),
    "src/export/markdown.ts": lines(
      'import { isoDate } from "../format.ts";',
      'import type { Row } from "../types.ts";',
      "",
      "export function toMarkdown(rows: Row[]): string {",
      '  const out = ["| name | amount | date |", "| --- | --- | --- |"];',
      '  for (const r of rows) out.push("| " + r.name + " | " + r.amount.toFixed(2) + " | " + isoDate(r.date) + " |");',
      '  return out.join("\\n") + "\\n";',
      "}",
    ),
    "src/export/csv.ts": CSV_BUG,
    "test/export.test.ts": testHead(
      'import { toJson } from "../src/export/json.ts";',
      'import { toMarkdown } from "../src/export/markdown.ts";',
    ).concat(
      lines(
        'const rows = [{ name: "rent", amount: 950, date: new Date(Date.UTC(2026, 9, 28, 12)) }];',
        'test("json", () => assert.match(toJson(rows), /"date":"2026-10-28"/));',
        'test("markdown", () => assert.match(toMarkdown(rows), /\\| 2026-10-28 \\|/));',
      ),
    ),
  },
  check: hiddenNode(
    "dates.hidden.test.ts",
    testHead(
      'import { toCsv } from "../src/export/csv.ts";',
      'import { toJson } from "../src/export/json.ts";',
      'import { toMarkdown } from "../src/export/markdown.ts";',
    ).concat(
      lines(
        "// Late in the evening, UTC: a local-time date would be a day off in many time zones.",
        'const rows = [{ name: "rent", amount: 950, date: new Date(Date.UTC(2026, 9, 28, 23, 30)) }];',
        'test("csv uses the same date as the other exports", () => {',
        '  assert.equal(toCsv(rows), "name,amount,date\\nrent,950.00,2026-10-28\\n");',
        "});",
        'test("the other exports did not change", () => {',
        '  assert.match(toJson(rows), /"date":"2026-10-28"/);',
        "  assert.match(toMarkdown(rows), /\\| 2026-10-28 \\|/);",
        "});",
      ),
    ),
  ),
  solution: {
    "src/export/csv.ts": CSV_BUG.replace(
      'import type { Row } from "../types.ts";',
      'import { isoDate } from "../format.ts";\nimport type { Row } from "../types.ts";',
    ).replace('r.date.toLocaleDateString("en-US")', "isoDate(r.date)"),
  },
};

export const HELD_OUT_TASKS: readonly EvalTask[] = [
  ledger,
  scheduler,
  inventory,
  renameOption,
  extractInterface,
  testsParser,
  testsLimiter,
  conventionsHandler,
  conventionsCli,
  ambiguousDates,
];
