import { homedir } from "node:os";
import { Readable } from "node:stream";
import { Runtime } from "../app/runtime.js";
import { auditDirFor } from "../audit/logger.js";
import {
  chooseModel,
  keepProviderKeys,
  loadModelsConfig,
  providerKeySource,
  type ResolvedModel,
  resolveModel,
} from "../model/providers.js";
import type { Approver } from "../permissions/types.js";
import { FileSessionStore } from "../session/store.js";
import { VERSION } from "../version.js";
import { loadSearchConfig } from "../web/search.js";

/** Garuda's sandbox and shell need macOS or Linux (0.16: said plainly to the editor). */
export const WINDOWS_MESSAGE =
  "Garuda supports macOS and Linux. On Windows, run Garuda in WSL (Windows Subsystem for Linux).";

/**
 * `garuda acp` (0.15, docs/lld/acp.md): Garuda as an agent for editors that speak the Agent Client
 * Protocol. The editor starts it and talks JSON-RPC over stdin and stdout.
 *
 * `garuda acp setup` (0.16) is ACP Terminal Auth: the editor runs its configured agent command with
 * `setup` added, in a terminal, and this runs `garuda setup`.
 */
export async function acpCommand(options: { model?: string; action?: string }): Promise<number> {
  if (options.action !== undefined) {
    if (options.action !== "setup") {
      process.stderr.write(`Unknown argument "${options.action}". Use: garuda acp [setup]\n`);
      return 1;
    }
    const { setupCommand, terminalIO } = await import("./setupCommand.js");
    return setupCommand({}, { io: await terminalIO() });
  }
  const output = protocolOutput(process.stdout, process.stderr);
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

  const { acpServer, setupNeeded } = await import("../acp/server.js");
  const server = acpServer({
    version: VERSION,
    // Not on native Windows: the setup there could not keep a key private (no 0600).
    ...(process.platform === "win32" ? {} : { terminalAuth: { args: ["setup"] } }),
    createRuntime: async ({ root, approver, onEvent, onNotice }) => {
      // Read again for each session (0.16): a session after `garuda setup` needs no restart.
      const setup = await prepare(options);
      if ("problem" in setup) {
        throw setup.setupNeeded ? setupNeeded(setup.problem) : new Error(setup.problem);
      }
      return createRuntime(setup, { root, approver, onEvent, onNotice });
    },
  });
  // No orphan process stays (F4): the editor may end Garuda with SIGTERM, or just close stdin.
  process.on("exit", () => server.shutdown());
  const stop = () => {
    server.shutdown();
    process.exit(143);
  };
  process.once("SIGTERM", stop);
  await server.serve(output, input);
  await server.close();
  return 0;
}

/** A stream with `write(chunk, callback)`, as process.stdout and process.stderr have. */
interface Out {
  write(chunk: Uint8Array | string, callback?: (error?: Error | null) => void): boolean;
}

/**
 * stdout carries only protocol messages. From here, everything else that writes to stdout (a
 * notice, a library) goes to stderr, which editors show in their logs; the returned stream writes
 * to the real stdout, for the SDK only.
 */
export function protocolOutput(stdout: Out, stderr: Out): WritableStream<Uint8Array> {
  const write = stdout.write.bind(stdout);
  // All arguments go on: a caller may pass an encoding before the callback.
  const toStderr = stderr.write.bind(stderr) as (...args: unknown[]) => boolean;
  stdout.write = ((...args: unknown[]) => toStderr(...args)) as Out["write"];
  return new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
  });
}

interface Setup {
  resolved: ResolvedModel;
  sub?: ResolvedModel;
  models: Awaited<ReturnType<typeof loadModelsConfig>>["config"];
  team?: { policy: NonNullable<Runtime["teamPolicy"]>; sources: string[] };
  search: Awaited<ReturnType<typeof loadSearchConfig>>;
  /** ~/.garuda/credentials was ignored (0.16): the reason, for the first session's notices. */
  credentialsWarning?: string;
}

/** Why a session cannot start. `setupNeeded`: no model or no key (ACP "auth required"). */
export interface SetupProblem {
  problem: string;
  setupNeeded: boolean;
}

/** Where `prepare` reads from: the defaults in use, temporary folders in tests. */
export interface PrepareFrom {
  home?: string;
  /** The managed team policy file; undefined: none. Default: the system's path. */
  managed?: string | undefined;
  platform?: NodeJS.Platform;
}

const SETUP_HINT = "Run `garuda setup` in a terminal, or use the editor's sign-in for Garuda.";

/**
 * The model, the providers, the team policy and web search: as for the chat, read again for each
 * session (0.16). A problem becomes the message of `session/new`, so the editor shows it (the
 * process itself keeps running).
 */
export async function prepare(
  options: { model?: string },
  from: PrepareFrom = {},
): Promise<Setup | SetupProblem> {
  const fail = (problem: string, setupNeeded = false): SetupProblem => ({ problem, setupNeeded });
  // Not "auth required": the editor would offer a setup that cannot help.
  if ((from.platform ?? process.platform) === "win32") return fail(WINDOWS_MESSAGE);
  const home = from.home ?? homedir();
  const models = await loadModelsConfig(home);
  if (models.problem !== undefined) return fail(models.problem);
  const spec = chooseModel(models.config, options.model, process.env.GARUDA_MODEL);
  if (!spec) return fail(`Garuda has no model. ${SETUP_HINT}`, true);
  let resolved: ResolvedModel;
  let sub: ResolvedModel | undefined;
  try {
    resolved = resolveModel(spec, models.config);
    const subSpec = process.env.GARUDA_SUBAGENT_MODEL;
    if (subSpec) sub = resolveModel(subSpec, models.config);
  } catch (error) {
    return fail((error as Error).message);
  }
  // Web search reads its keys before the model keys leave the environment.
  const search = await loadSearchConfig(home);
  // The provider keys leave Garuda's own environment (0.14, review), as in the terminal; stored
  // keys fill the rest (0.16).
  const credentialsWarning = await keepProviderKeys(
    [resolved.def.apiKeyEnv, sub?.def.apiKeyEnv, "ANTHROPIC_API_KEY"],
    home,
  );
  if (credentialsWarning !== undefined) process.stderr.write(`garuda acp: ${credentialsWarning}\n`);
  const keyName =
    resolved.def.type === "anthropic"
      ? (resolved.def.apiKeyEnv ?? "ANTHROPIC_API_KEY")
      : resolved.def.apiKeyEnv;
  // ANTHROPIC_AUTH_TOKEN: the SDK's other way to sign in, which Garuda leaves to the SDK.
  const sdkToken =
    resolved.def.type === "anthropic" && (process.env.ANTHROPIC_AUTH_TOKEN ?? "") !== "";
  if (keyName !== undefined && providerKeySource(keyName) === undefined && !sdkToken) {
    const why = credentialsWarning === undefined ? "" : ` ${credentialsWarning}`;
    return fail(`Garuda has no key for ${resolved.spec} (${keyName}).${why} ${SETUP_HINT}`, true);
  }
  const { loadTeamPolicy } = await import("../permissions/policy.js");
  let team: Awaited<ReturnType<typeof loadTeamPolicy>>;
  try {
    team = await loadTeamPolicy("managed" in from ? { home, managed: from.managed } : { home });
  } catch (error) {
    return fail(`Team policy: ${(error as Error).message}`);
  }
  return {
    resolved,
    ...(sub === undefined ? {} : { sub }),
    models: models.config,
    ...(team === undefined ? {} : { team: { policy: team.policy, sources: team.sources } }),
    search,
    ...(credentialsWarning === undefined ? {} : { credentialsWarning }),
  };
}

function createRuntime(
  setup: Setup,
  input: {
    root: string;
    approver: Approver;
    onEvent: Parameters<typeof Runtime.create>[0]["onEvent"];
    onNotice: (text: string) => void;
  },
): Promise<Runtime> {
  const { resolved, sub, models, team, search } = setup;
  return Runtime.create({
    root: input.root,
    modelId: resolved.spec,
    ...(team === undefined ? {} : { policy: team.policy, policySources: team.sources }),
    audit: { dir: auditDirFor(input.root) },
    model: () => resolved.create(),
    modelInfo: resolved.info,
    ...(resolved.maxTokens === undefined ? {} : { maxTokens: resolved.maxTokens }),
    ...(sub === undefined
      ? {}
      : { subagentModel: { spec: sub.spec, model: () => sub.create(), info: sub.info } }),
    approver: input.approver,
    store: new FileSessionStore(input.root),
    undo: {},
    skills: {},
    languages: {},
    // The editor cannot answer a question before session/new returns: only project settings that
    // the user approved in a terminal apply; the rest is left out with a notice (docs/lld/acp.md).
    projectSettings: { home: homedir(), ask: false },
    ...(search.config === undefined && search.claude === undefined
      ? {}
      : {
          search: {
            ...(search.config === undefined ? {} : { config: search.config }),
            ...(search.claude === undefined ? {} : { claude: search.claude }),
            ...(search.use === undefined ? {} : { use: search.use }),
            home: homedir(),
          },
        }),
    agents: {
      resolveModel: (spec: string) => {
        const r = resolveModel(spec, models);
        return { spec: r.spec, model: () => r.create(), info: r.info };
      },
    },
    models: {
      resolve: (spec: string) => {
        const r = resolveModel(spec, models);
        return {
          spec: r.spec,
          model: () => r.create(),
          info: r.info,
          ...(r.maxTokens === undefined ? {} : { maxTokens: r.maxTokens }),
        };
      },
      configured: Object.keys(models.models),
    },
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    onNotice: input.onNotice,
  }).then((runtime) => {
    if (setup.credentialsWarning !== undefined) input.onNotice(setup.credentialsWarning);
    return runtime;
  });
}
