import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LSP_CONFIG_FILE, loadLspConfig } from "../lsp/config.js";
import { installServer } from "../lsp/install.js";
import { LspManager, lspStatusText } from "../lsp/manager.js";
import { LSP_LANGUAGES, type LspLanguage } from "../lsp/servers.js";
import { loadSettings } from "../permissions/settings.js";
import { HostExecutor } from "../sandbox/host.js";
import { createExecutor } from "../sandbox/index.js";

/**
 * `garuda lsp` and `garuda lsp install <language>` (0.4). The status starts no server; the install
 * is the managed one (npm into ~/.garuda/lsp/<language>).
 */

export async function lspStatusCommand(): Promise<number> {
  const root = realpathSync(process.cwd());
  let enabled = false;
  let executorName: "auto" | "os" | "host" = "auto";
  try {
    const settings = await loadSettings(root);
    enabled = settings.lsp?.enabled === true;
    executorName = settings.executor;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
  }
  const { executor } = createExecutor(executorName);
  const manager = new LspManager({ root, executor, policy: unused });
  const how =
    'Turn them on with garuda --lsp, or "lsp": { "enabled": true } in .garuda/settings.json.';
  const lines = [lspStatusText(manager.status(), { on: enabled, how })];
  if (executor.isolation === "none") {
    lines.push("No OS sandbox here: language servers run only in the sandbox, so they stay off.");
  }
  try {
    const config = await loadLspConfig();
    lines.push(
      config.autoInstall
        ? `autoInstall is on (~/${LSP_CONFIG_FILE}): Garuda asks to install a missing server.`
        : `To be asked to install a missing server, put { "autoInstall": true } in ~/${LSP_CONFIG_FILE}.`,
    );
  } catch (error) {
    lines.push((error as Error).message);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export async function lspInstallCommand(language: string): Promise<number> {
  if (!(LSP_LANGUAGES as readonly string[]).includes(language)) {
    process.stderr.write(`Unknown language ${language}. Use: ${LSP_LANGUAGES.join(", ")}.\n`);
    return 1;
  }
  const lang = language as LspLanguage;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("stopped by the user"));
  process.once("SIGINT", stop);
  try {
    process.stderr.write(`Installing into ${join(homedir(), ".garuda", "lsp", lang)} …\n`);
    // npm needs the network, so it runs outside the sandbox: the host executor (N8).
    const result = await installServer(lang, {
      executor: new HostExecutor(),
      signal: controller.signal,
    });
    if (!result.ok) {
      process.stderr.write(`The install failed.\n$ ${result.command}\n${result.output ?? ""}\n`);
      return 1;
    }
    process.stdout.write(`Installed. Check it with: garuda lsp\n`);
    return 0;
  } finally {
    process.off("SIGINT", stop);
  }
}

function unused(): never {
  throw new Error("The status starts no server.");
}
