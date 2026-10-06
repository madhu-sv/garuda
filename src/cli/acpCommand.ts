import { homedir } from "node:os";
import { Readable } from "node:stream";
import { Runtime } from "../app/runtime.js";
import { auditDirFor } from "../audit/logger.js";
import {
  chooseModel,
  keepProviderKeys,
  loadModelsConfig,
  NO_MODEL,
  type ResolvedModel,
  resolveModel,
} from "../model/providers.js";
import type { Approver } from "../permissions/types.js";
import { FileSessionStore } from "../session/store.js";
import { VERSION } from "../version.js";
import { loadSearchConfig } from "../web/search.js";

/**
 * `garuda acp` (0.15, docs/lld/acp.md): Garuda as an agent for editors that speak the Agent Client
 * Protocol. The editor starts it and talks JSON-RPC over stdin and stdout.
 */
export async function acpCommand(options: { model?: string }): Promise<number> {
  const output = protocolOutput(process.stdout, process.stderr);
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;

  const setup = await prepare(options);
  const { acpServer } = await import("../acp/server.js");
  const server = acpServer({
    version: VERSION,
    createRuntime: async ({ root, approver, onEvent, onNotice }) => {
      if (typeof setup === "string") throw new Error(setup);
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

/**
 * The model, the providers, the team policy and web search: as for the chat. A problem becomes the
 * message of `session/new`, so the editor shows it (the process itself keeps running).
 */
async function prepare(options: { model?: string }): Promise<Setup | string> {
  const models = await loadModelsConfig();
  if (models.problem !== undefined) return models.problem;
  const spec = chooseModel(models.config, options.model, process.env.GARUDA_MODEL);
  if (!spec) return NO_MODEL;
  let resolved: ResolvedModel;
  let sub: ResolvedModel | undefined;
  try {
    resolved = resolveModel(spec, models.config);
    const subSpec = process.env.GARUDA_SUBAGENT_MODEL;
    if (subSpec) sub = resolveModel(subSpec, models.config);
  } catch (error) {
    return (error as Error).message;
  }
  // Web search reads its keys before the model keys leave the environment.
  const search = await loadSearchConfig();
  // The provider keys leave Garuda's own environment (0.14, review), as in the terminal; stored
  // keys fill the rest (0.16).
  const credentialsWarning = await keepProviderKeys([
    resolved.def.apiKeyEnv,
    sub?.def.apiKeyEnv,
    "ANTHROPIC_API_KEY",
  ]);
  if (credentialsWarning !== undefined) process.stderr.write(`garuda acp: ${credentialsWarning}\n`);
  const { loadTeamPolicy } = await import("../permissions/policy.js");
  let team: Awaited<ReturnType<typeof loadTeamPolicy>>;
  try {
    team = await loadTeamPolicy();
  } catch (error) {
    return `Team policy: ${(error as Error).message}`;
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
