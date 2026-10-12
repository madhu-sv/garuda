/** Optional, live LSP capture. Normal validation uses the frozen oracle, offline. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const { values } = parseArgs({
  options: {
    jdtls: { type: "string" },
    pyright: { type: "string" },
    "java-home": { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["jdtls", "pyright", "java-home", "output"])
  if (!values[key])
    throw new Error(
      `Required: --${key}. This command never installs tools or replaces evidence implicitly.`,
    );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = readFileSync(
  new URL("../test/fixtures/code-intelligence-lsp-corpus.json", import.meta.url),
);
const corpus = JSON.parse(bytes);
const jdtls = realpathSync(values.jdtls);
const javaHome = realpathSync(values["java-home"]);
const pyright = realpathSync(values.pyright);
const pyrightPackage = JSON.parse(readFileSync(join(dirname(pyright), "package.json"), "utf8"));
if (pyrightPackage.name !== "pyright" || pyrightPackage.version !== "1.1.406")
  throw new Error(
    "This corpus is pinned to pyright 1.1.406; review and record a version change explicitly.",
  );
const coreJar = readdirSync(join(jdtls, "plugins")).find((n) =>
  /^org\.eclipse\.jdt\.ls\.core_1\.61\.0\./.test(n),
);
const launcherJar = readdirSync(join(jdtls, "plugins")).find(
  (n) => n.startsWith("org.eclipse.equinox.launcher_") && n.endsWith(".jar"),
);
if (!coreJar || !launcherJar)
  throw new Error("Expected jdtls 1.61.0 install directory with plugins/.");
const javaRelease = readFileSync(join(javaHome, "release"), "utf8");
const javaVersion = /^JAVA_VERSION="([^"]+)"/m.exec(javaRelease)?.[1];
if (!javaVersion || Number(javaVersion.split(".")[0]) < 21)
  throw new Error("jdtls requires a Java 21+ JDK.");
const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-reference-oracle-")));
const settings = {
  java: { import: { generatesMetadataFilesAtProjectRoot: false }, autobuild: { enabled: true } },
  python: { analysis: { diagnosticMode: "workspace" } },
};
const captures = [];

async function capture(project) {
  const root = join(base, project.language);
  mkdirSync(root, { recursive: true });
  for (const [path, text] of Object.entries(project.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const config =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "config_mac_arm"
        : "config_mac"
      : "config_linux";
  const argv =
    project.language === "java"
      ? [
          join(javaHome, "bin", "java"),
          "-Declipse.application=org.eclipse.jdt.ls.core.id1",
          "-Dosgi.bundles.defaultStartLevel=4",
          "-Declipse.product=org.eclipse.jdt.ls.core.product",
          `-Dosgi.sharedConfiguration.area=${join(jdtls, config)}`,
          "-Dosgi.sharedConfiguration.area.readOnly=true",
          "-Dosgi.configuration.cascaded=true",
          "-Xmx1G",
          "--add-modules=ALL-SYSTEM",
          "--add-opens",
          "java.base/java.util=ALL-UNNAMED",
          "--add-opens",
          "java.base/java.lang=ALL-UNNAMED",
          "-jar",
          join(jdtls, "plugins", launcherJar),
          "-configuration",
          join(base, "config"),
          "-data",
          join(base, "workspace"),
        ]
      : [pyright, "--stdio"];
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-16000);
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  let fatal;
  let started = project.language !== "java";
  const errors = new Map();
  child.on("error", (error) => {
    fatal = error;
  });
  child.on("exit", (code, signal) => {
    fatal ??= new Error(`Server exited: ${code}/${signal}\n${stderr}`);
  });
  connection.onRequest("workspace/configuration", ({ items }) =>
    items.map(({ section }) => section?.split(".").reduce((v, key) => v?.[key], settings) ?? null),
  );
  connection.onRequest(() => null);
  connection.onNotification("language/status", (status) => {
    console.info(`${project.language} status: ${status.type}`);
    if (status.type === "Error") fatal = new Error(`jdtls import failed: ${status.message}`);
    if (status.type === "Started") started = true;
  });
  connection.onNotification("textDocument/publishDiagnostics", ({ uri, diagnostics }) => {
    errors.set(
      uri,
      diagnostics.filter((d) => d.severity === 1),
    );
  });
  connection.onNotification(() => {});
  connection.listen();
  const pause = () => new Promise((done) => setTimeout(done, 250));
  const request = async (method, params, ms = 60000) => {
    if (fatal) throw fatal;
    const cancel = new CancellationTokenSource();
    let timer;
    try {
      return await Promise.race([
        connection.sendRequest(method, params, cancel.token),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            cancel.cancel();
            reject(new Error(`${project.language}: ${method} timed out`));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      cancel.dispose();
    }
  };
  const location = (item) => {
    const path = relative(root, fileURLToPath(item.uri ?? item.targetUri)).replaceAll("\\", "/");
    if (!(path in project.files)) throw new Error(`Reference outside the frozen project: ${path}`);
    const range = item.range ?? item.targetSelectionRange;
    if (!Number.isInteger(range?.start?.line) || !Number.isInteger(range?.start?.character))
      throw new Error("Invalid LSP location");
    if (range.start.line < 0 || range.start.line >= project.files[path].split("\n").length)
      throw new Error("LSP line outside file");
    return { path, range };
  };
  try {
    const uri = pathToFileURL(root).href;
    const init = await request(
      "initialize",
      {
        processId: null,
        rootUri: uri,
        workspaceFolders: [{ uri, name: "shopkit" }],
        capabilities: {
          workspace: { configuration: true },
          textDocument: { references: {}, definition: { linkSupport: true } },
        },
        initializationOptions: { settings },
      },
      120000,
    );
    if (!init.capabilities.referencesProvider) throw new Error("Server does not offer references");
    await connection.sendNotification("initialized", {});
    await connection.sendNotification("workspace/didChangeConfiguration", { settings });
    const deadline = Date.now() + 120000;
    while (!started) {
      if (fatal) throw fatal;
      if (Date.now() > deadline) throw new Error("jdtls did not report Started");
      await pause();
    }
    for (const [path, text] of Object.entries(project.files)) {
      if (!path.endsWith(project.language === "java" ? ".java" : ".py")) continue;
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(join(root, path)).href,
          languageId: project.language,
          version: 1,
          text,
        },
      });
    }
    const documents = Object.keys(project.files).filter((p) =>
      p.endsWith(project.language === "java" ? ".java" : ".py"),
    );
    const analyzedDeadline = Date.now() + 120000;
    while (!documents.every((p) => errors.has(pathToFileURL(join(root, p)).href))) {
      if (fatal) throw fatal;
      if (Date.now() > analyzedDeadline)
        throw new Error("Not all frozen documents were analyzed; no oracle written");
      await pause();
    }
    const rows = [];
    for (const query of project.queries) {
      const params = {
        textDocument: { uri: pathToFileURL(join(root, query.path)).href },
        position: { line: query.definitionLine - 1, character: query.character },
      };
      const def = await request("textDocument/definition", params);
      const definitions = (Array.isArray(def) ? def : def ? [def] : []).map(location);
      if (
        !definitions.some(
          (d) => d.path === query.path && d.range.start.line + 1 === query.definitionLine,
        )
      )
        throw new Error(`${query.id}: server did not bind the selected declaration`);
      const refs = async () => {
        const result = await request("textDocument/references", {
          ...params,
          context: { includeDeclaration: true },
        });
        if (!Array.isArray(result)) throw new Error(`${query.id}: no reference array`);
        return result
          .map(location)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      };
      const first = await refs();
      await pause();
      const second = await refs();
      if (JSON.stringify(first) !== JSON.stringify(second))
        throw new Error(`${query.id}: indexing was unstable; no oracle written`);
      if (
        !first.some((r) => r.path === query.path && r.range.start.line + 1 === query.definitionLine)
      )
        throw new Error(`${query.id}: missing included declaration`);
      const declaration = `${query.path}:${query.definitionLine}`;
      const expected = [...new Set(first.map((r) => `${r.path}:${r.range.start.line + 1}`))]
        .filter((s) => s !== declaration)
        .sort();
      if (expected.length === 0)
        throw new Error(
          `${query.id}: every fixture has a positive use; empty gold rejected. ${JSON.stringify(first)} Diagnostics: ${JSON.stringify([...errors])}`,
        );
      rows.push({ id: query.id, expected, locations: first });
      console.info(`${query.id}: ${expected.length} reference sites`);
    }
    const failures = [...errors].filter(([, rows]) => rows.length);
    if (failures.length)
      throw new Error(`Invalid fixture diagnostics: ${JSON.stringify(failures)}`);
    return {
      language: project.language,
      server: init.serverInfo ?? null,
      stablePasses: 2,
      cases: rows,
    };
  } finally {
    connection.dispose();
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
}

try {
  for (const project of corpus.projects) captures.push(await capture(project));
  const report = {
    schemaVersion: 1,
    corpusId: corpus.id,
    corpusSha256: hash(bytes),
    capturedAt: new Date().toISOString(),
    toolchain: {
      jdtls: {
        version: "1.61.0",
        coreJar,
        coreJarSha256: hash(readFileSync(join(jdtls, "plugins", coreJar))),
      },
      pyright: { version: pyrightPackage.version },
      java: javaVersion,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    projects: captures,
  };
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.info(`Captured all 60 queries: ${output}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
