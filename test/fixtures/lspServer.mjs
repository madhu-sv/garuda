// A fake language server for the LSP tests (0.4). The first argument picks a mode:
//   pull       offers diagnosticProvider and answers textDocument/diagnostic
//   push       sends publishDiagnostics with the document version
//   push-old   sends a stale publishDiagnostics first, then the right one
//   silent     never gives diagnostics (the client times out)
//   crash      exits when a file opens
//   slow-init  answers initialize after 400 ms, then works as pull
//   jdtls      like jdtls: needs its settings; says language/status "Started" after 300 ms, and
//              before that gives a wrong "not ready" error
// A line with ERROR gives an error there; WARN gives a warning; NOSEV gives no severity.
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const mode = process.argv[2] ?? "pull";
const pull = mode === "pull" || mode === "slow-init";
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const docs = new Map();
let started = mode !== "jdtls";

function diagnose(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [word, severity] of [
      ["ERROR", 1],
      ["WARN", 2],
      ["NOSEV", undefined],
    ]) {
      const at = line.indexOf(word);
      if (at === -1) continue;
      out.push({
        range: { start: { line: i, character: at }, end: { line: i, character: at + word.length } },
        ...(severity === undefined ? {} : { severity }),
        message: `${word.toLowerCase()} here\nsecond line`,
        code: `X${i + 1}`,
      });
    }
  });
  return out;
}

function publish(uri) {
  const doc = docs.get(uri);
  if (mode === "silent") return;
  if (mode === "push-old") {
    connection.sendNotification("textDocument/publishDiagnostics", {
      uri,
      version: doc.version - 1,
      diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "stale" }],
    });
  }
  setTimeout(() => {
    const wrong = [
      { range: { start: { line: 0, character: 0 } }, severity: 1, message: "not ready" },
    ];
    connection.sendNotification("textDocument/publishDiagnostics", {
      uri,
      version: doc.version,
      diagnostics: started ? diagnose(doc.text) : wrong,
    });
  }, 20);
}

connection.onRequest("initialize", async (params) => {
  const java = params.initializationOptions?.settings?.java;
  if (mode === "jdtls" && java?.import?.generatesMetadataFilesAtProjectRoot !== false)
    process.exit(4);
  if (mode === "slow-init") await new Promise((r) => setTimeout(r, 400));
  // Real servers ask for settings; the client must answer.
  const settings = await connection.sendRequest("workspace/configuration", {
    items: [{ section: "fake" }],
  });
  if (!Array.isArray(settings)) process.exit(3);
  return {
    capabilities: { textDocumentSync: 1, ...(pull ? { diagnosticProvider: {} } : {}) },
  };
});
connection.onNotification("initialized", () => {
  if (mode !== "jdtls") return;
  connection.sendNotification("language/status", { type: "Starting", message: "Init..." });
  setTimeout(() => {
    started = true;
    connection.sendNotification("language/status", { type: "Started", message: "Ready" });
  }, 300);
});
connection.onNotification("textDocument/didOpen", ({ textDocument }) => {
  if (mode === "crash") process.exit(2);
  docs.set(textDocument.uri, { version: textDocument.version, text: textDocument.text });
  if (!pull) publish(textDocument.uri);
});
connection.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) => {
  docs.set(textDocument.uri, { version: textDocument.version, text: contentChanges[0].text });
  if (!pull) publish(textDocument.uri);
});
connection.onRequest("textDocument/diagnostic", ({ textDocument }) => ({
  kind: "full",
  items: diagnose(docs.get(textDocument.uri)?.text ?? ""),
}));
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
