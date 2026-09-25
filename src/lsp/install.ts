import { mkdir } from "node:fs/promises";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import type { ExecPolicy, Executor } from "../sandbox/types.js";
import { type LspLanguage, MANAGED_PACKAGES, managedDir } from "./servers.js";

/**
 * The managed install (0.4): `npm install` of a pinned server into ~/.garuda/lsp/<language>.
 * Only the user starts it: `garuda lsp install`, `/lsp install`, or a "yes" to the question that
 * `autoInstall` adds. It needs the network, so it runs outside the sandbox, through the Executor
 * (N8). Install scripts are off (`--ignore-scripts`): the pinned packages need none.
 */

export const INSTALL_TIMEOUT_MS = 300_000;

/** Proxy and registry variables that npm may need, on top of the default list. */
const NPM_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
];

export interface InstallResult {
  ok: boolean;
  /** Where the server went. */
  dir: string;
  /** The command that ran, for the user. */
  command: string;
  /** The last lines of npm's output, when it failed. */
  output?: string;
}

export function installCommand(language: LspLanguage, dir: string): string {
  return [
    "npm",
    "install",
    "--prefix",
    quote(dir),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...MANAGED_PACKAGES[language],
  ].join(" ");
}

export async function installServer(
  language: LspLanguage,
  options: { executor: Executor; home?: string; signal?: AbortSignal },
): Promise<InstallResult> {
  const dir = managedDir(language, options.home);
  await mkdir(dir, { recursive: true });
  const command = installCommand(language, dir);
  const policy: ExecPolicy = {
    root: dir,
    sandbox: false,
    writePaths: [],
    denyWritePaths: [],
    denyReadPaths: [],
    network: true,
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...NPM_ENV],
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: 20_000,
  };
  const result = await options.executor.run(
    command,
    policy,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (result.exitCode === 0) return { ok: true, dir, command };
  const why = result.timedOut
    ? `npm took longer than ${INSTALL_TIMEOUT_MS / 1000} s.`
    : [result.stderr.text, result.stdout.text].join("\n").trim().split("\n").slice(-8).join("\n");
  return { ok: false, dir, command, output: why || `npm exited with ${result.exitCode}.` };
}

/** Quote for bash: a path in single quotes. */
function quote(text: string): string {
  return /^[\w./:@-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}
