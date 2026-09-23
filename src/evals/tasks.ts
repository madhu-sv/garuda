import type { EvalTask } from "./types.js";

/**
 * The 10 eval tasks of Garuda 0.1 (N5). Each is a small Node project with no dependencies.
 * Tests use node:test, so `node --test` runs them with no install step.
 */

const pkg = '{ "name": "eval", "type": "module", "private": true }\n';
const lines = (...l: string[]) => `${l.join("\n")}\n`;
const imports = (from: string, names: string) =>
  lines(
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    `import { ${names} } from "${from}";`,
  );

export const EVAL_TASKS: readonly EvalTask[] = [
  {
    id: "fix-add",
    title: "Fix a wrong operator",
    prompt: "The tests fail. Find the bug and fix it. Do not change the tests.",
    files: {
      "package.json": pkg,
      "src/math.js": lines("export function add(a, b) {", "  return a - b;", "}"),
      "test/math.test.js": `${imports("../src/math.js", "add")}test("add", () => assert.equal(add(2, 3), 5));\n`,
    },
    check: "node --test",
    solution: { "src/math.js": lines("export function add(a, b) {", "  return a + b;", "}") },
  },
  {
    id: "off-by-one",
    title: "Fix an off-by-one error",
    prompt:
      "range(n) should return [0, 1, …, n-1], but a test fails. Fix it without changing the tests.",
    files: {
      "package.json": pkg,
      "src/range.js": lines(
        "export function range(n) {",
        "  const out = [];",
        "  for (let i = 0; i < n - 1; i++) out.push(i);",
        "  return out;",
        "}",
      ),
      "test/range.test.js": `${imports("../src/range.js", "range")}${lines(
        'test("range", () => {',
        "  assert.deepEqual(range(3), [0, 1, 2]);",
        "  assert.deepEqual(range(0), []);",
        "});",
      )}`,
    },
    check: "node --test",
    solution: {
      "src/range.js": lines(
        "export function range(n) {",
        "  const out = [];",
        "  for (let i = 0; i < n; i++) out.push(i);",
        "  return out;",
        "}",
      ),
    },
  },
  {
    id: "rename",
    title: "Rename a function in every file",
    prompt:
      "Rename the function getUsr to getUser everywhere in src/ (definition and every use). Then run the tests.",
    files: {
      "package.json": pkg,
      "src/users.js": lines(
        "export function getUsr(id) {",
        "  return { id, name: `user-${id}` };",
        "}",
      ),
      "src/profile.js": lines(
        'import { getUsr } from "./users.js";',
        "export const profile = (id) => `Profile of ${getUsr(id).name}`;",
      ),
      "src/admin.js": lines(
        'import { getUsr } from "./users.js";',
        "export const isAdmin = (id) => getUsr(id).id === 1;",
      ),
      "test/users.test.js": `${imports("../src/users.js", "getUser")}${lines(
        'import { profile } from "../src/profile.js";',
        'import { isAdmin } from "../src/admin.js";',
        'test("rename", () => {',
        '  assert.equal(getUser(2).name, "user-2");',
        '  assert.equal(profile(3), "Profile of user-3");',
        "  assert.equal(isAdmin(1), true);",
        "});",
      )}`,
    },
    check: "node --test && ! grep -rq getUsr src",
    solution: {
      "src/users.js": lines(
        "export function getUser(id) {",
        "  return { id, name: `user-${id}` };",
        "}",
      ),
      "src/profile.js": lines(
        'import { getUser } from "./users.js";',
        "export const profile = (id) => `Profile of ${getUser(id).name}`;",
      ),
      "src/admin.js": lines(
        'import { getUser } from "./users.js";',
        "export const isAdmin = (id) => getUser(id).id === 1;",
      ),
    },
  },
  {
    id: "implement-slugify",
    title: "Implement a function from its tests",
    prompt: "Implement slugify in src/slugify.js so that the tests pass.",
    files: {
      "package.json": pkg,
      "src/slugify.js": lines(
        "export function slugify(text) {",
        '  throw new Error("not implemented");',
        "}",
      ),
      "test/slugify.test.js": `${imports("../src/slugify.js", "slugify")}${lines(
        'test("slugify", () => {',
        '  assert.equal(slugify("Hello World"), "hello-world");',
        '  assert.equal(slugify("  Many   spaces  "), "many-spaces");',
        '  assert.equal(slugify("Café & Crème!"), "cafe-creme");',
        '  assert.equal(slugify("a--b"), "a-b");',
        "});",
      )}`,
    },
    check: "node --test",
    solution: {
      "src/slugify.js": lines(
        "export function slugify(text) {",
        "  return text",
        '    .normalize("NFKD")',
        '    .replace(/[\\u0300-\\u036f]/g, "")',
        "    .toLowerCase()",
        '    .replace(/[^a-z0-9]+/g, "-")',
        '    .replace(/^-+|-+$/g, "");',
        "}",
      ),
    },
  },
  {
    id: "missing-await",
    title: "Fix a missing await",
    prompt:
      "loadTotal sometimes returns the wrong value and its test fails. Find the cause and fix it.",
    files: {
      "package.json": pkg,
      "src/total.js": lines(
        "const fetchPrices = async () => {",
        "  await new Promise((r) => setTimeout(r, 5));",
        "  return [3, 4, 5];",
        "};",
        "",
        "export async function loadTotal() {",
        "  const prices = fetchPrices();",
        "  let total = 0;",
        "  for (const p of prices ?? []) total += p;",
        "  return total;",
        "}",
      ),
      "test/total.test.js": `${imports("../src/total.js", "loadTotal")}test("total", async () => assert.equal(await loadTotal(), 12));\n`,
    },
    check: "node --test",
    solution: {
      "src/total.js": lines(
        "const fetchPrices = async () => {",
        "  await new Promise((r) => setTimeout(r, 5));",
        "  return [3, 4, 5];",
        "};",
        "",
        "export async function loadTotal() {",
        "  const prices = await fetchPrices();",
        "  let total = 0;",
        "  for (const p of prices ?? []) total += p;",
        "  return total;",
        "}",
      ),
    },
  },
  {
    id: "csv-quotes",
    title: "Handle quoted fields in a CSV parser",
    prompt:
      'parseLine splits a CSV line at commas. It must also handle fields in double quotes that contain commas and escaped quotes (""). Fix it so the tests pass.',
    files: {
      "package.json": pkg,
      "src/csv.js": lines("export function parseLine(line) {", '  return line.split(",");', "}"),
      "test/csv.test.js": `${imports("../src/csv.js", "parseLine")}${lines(
        'test("plain", () => assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]));',
        'test("quoted comma", () => assert.deepEqual(parseLine(\'x,"a, b",y\'), ["x", "a, b", "y"]));',
        'test("escaped quote", () => assert.deepEqual(parseLine(\'"say ""hi""",z\'), [\'say "hi"\', "z"]));',
        'test("empty fields", () => assert.deepEqual(parseLine("a,,b"), ["a", "", "b"]));',
      )}`,
    },
    check: "node --test",
    solution: {
      "src/csv.js": lines(
        "export function parseLine(line) {",
        "  const out = [];",
        '  let field = "";',
        "  let quoted = false;",
        "  for (let i = 0; i < line.length; i++) {",
        "    const c = line[i];",
        "    if (quoted) {",
        "      if (c === '\"' && line[i + 1] === '\"') { field += '\"'; i++; }",
        "      else if (c === '\"') quoted = false;",
        "      else field += c;",
        "    } else if (c === '\"') quoted = true;",
        '    else if (c === ",") { out.push(field); field = ""; }',
        "    else field += c;",
        "  }",
        "  out.push(field);",
        "  return out;",
        "}",
      ),
    },
  },
  {
    id: "write-tests",
    title: "Write tests for existing code",
    prompt:
      "Write a test file test/isPrime.test.js for src/isPrime.js with node:test. Cover at least 0, 1, 2, a prime above 10 and a composite number. Run it.",
    files: {
      "package.json": pkg,
      "src/isPrime.js": lines(
        "export function isPrime(n) {",
        "  if (n < 2) return false;",
        "  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;",
        "  return true;",
        "}",
      ),
    },
    check:
      'test -f test/isPrime.test.js && node --test && [ "$(grep -c "assert" test/isPrime.test.js)" -ge 4 ]',
    protect: ["src/isPrime.js"],
    solution: {
      "test/isPrime.test.js": `${imports("../src/isPrime.js", "isPrime")}${lines(
        'test("isPrime", () => {',
        "  assert.equal(isPrime(0), false);",
        "  assert.equal(isPrime(1), false);",
        "  assert.equal(isPrime(2), true);",
        "  assert.equal(isPrime(13), true);",
        "  assert.equal(isPrime(15), false);",
        "});",
      )}`,
    },
  },
  {
    id: "config-default",
    title: "Add a default value",
    prompt:
      "loadConfig must use port 3000 when the config has no port, but keep a port that is set. Make the tests pass.",
    files: {
      "package.json": pkg,
      "src/config.js": lines(
        "export function loadConfig(json) {",
        "  const config = JSON.parse(json);",
        "  return config;",
        "}",
      ),
      "test/config.test.js": `${imports("../src/config.js", "loadConfig")}${lines(
        'test("default port", () => assert.equal(loadConfig(\'{"host":"x"}\').port, 3000));',
        'test("set port", () => assert.equal(loadConfig(\'{"port":8080}\').port, 8080));',
        'test("keeps other keys", () => assert.equal(loadConfig(\'{"host":"x"}\').host, "x"));',
      )}`,
    },
    check: "node --test",
    solution: {
      "src/config.js": lines(
        "export function loadConfig(json) {",
        "  const config = JSON.parse(json);",
        "  return { port: 3000, ...config };",
        "}",
      ),
    },
  },
  {
    id: "new-module",
    title: "Create a new module",
    prompt:
      'Create src/version.js that exports a constant VERSION with the "version" value from package.json (read the file; do not import JSON). The test must pass.',
    files: {
      "package.json": '{ "name": "eval", "version": "1.2.3", "type": "module", "private": true }\n',
      "test/version.test.js": `${imports("../src/version.js", "VERSION")}test("version", () => assert.equal(VERSION, "1.2.3"));\n`,
    },
    check: "node --test",
    solution: {
      "src/version.js": lines(
        'import { readFileSync } from "node:fs";',
        'const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
        "export const VERSION = pkg.version;",
      ),
    },
  },
  {
    id: "extract-helper",
    title: "Remove duplicate code",
    prompt:
      "signup.js and invite.js have the same e-mail check. Move it into a function isValidEmail(text) exported from src/email.js, and use it in both files. The tests must still pass.",
    files: {
      "package.json": pkg,
      "src/signup.js": lines(
        "export function signup(email) {",
        '  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) throw new Error("bad email");',
        "  return { email };",
        "}",
      ),
      "src/invite.js": lines(
        "export function invite(email) {",
        '  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) throw new Error("bad email");',
        "  return { invited: email };",
        "}",
      ),
      "test/email.test.js": `${imports("../src/signup.js", "signup")}${lines(
        'import { invite } from "../src/invite.js";',
        'test("signup", () => { assert.equal(signup("a@b.co").email, "a@b.co"); assert.throws(() => signup("nope")); });',
        'test("invite", () => { assert.equal(invite("a@b.co").invited, "a@b.co"); assert.throws(() => invite("x@y")); });',
      )}`,
    },
    check: [
      "node --test",
      'node -e \'import("./src/email.js").then((m) => process.exit(m.isValidEmail("a@b.co") && !m.isValidEmail("x") ? 0 : 1))\'',
      "grep -q isValidEmail src/signup.js",
      "grep -q isValidEmail src/invite.js",
      // The e-mail pattern must appear only once in src/ after the change.
      '[ "$(cat src/*.js | grep -c "\\[^@")" -le 1 ]',
    ].join(" && "),
    solution: {
      "src/email.js": lines(
        "export function isValidEmail(text) {",
        "  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(text);",
        "}",
      ),
      "src/signup.js": lines(
        'import { isValidEmail } from "./email.js";',
        "export function signup(email) {",
        '  if (!isValidEmail(email)) throw new Error("bad email");',
        "  return { email };",
        "}",
      ),
      "src/invite.js": lines(
        'import { isValidEmail } from "./email.js";',
        "export function invite(email) {",
        '  if (!isValidEmail(email)) throw new Error("bad email");',
        "  return { invited: email };",
        "}",
      ),
    },
  },
];
