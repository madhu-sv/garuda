import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  type AgentApp,
  type AvailableCommand,
  agent,
  type InitializeResponse,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type SessionModeState,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { Runtime } from "../app/runtime.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import type { AgentEvent } from "../loop/events.js";
import type { AgentStopReason } from "../loop/limits.js";
import type { AgentMode, Approver } from "../permissions/types.js";
import { AcpApprover } from "./approver.js";
import { promptText } from "./prompt.js";
import { type AcpClient, EventMapper, KnownCalls, SessionChannel } from "./updates.js";

/** What `garuda acp` gives the server: how to make the runtime of one editor session. */
export interface AcpServerOptions {
  version: string;
  /**
   * Terminal Auth (0.16, docs/lld/setup.md): the editor runs the agent's own command with these
   * arguments added, in a terminal (`garuda acp setup`). Offered only to an editor that declares
   * `auth.terminal`. Undefined: no auth method (for example on native Windows).
   */
  terminalAuth?: { args: string[] };
  /**
   * Make the runtime of one session. An error with `authRequired: true` (no model or no key) ends
   * `session/new` with ACP's "auth required", so the editor can offer the setup.
   */
  createRuntime(input: {
    root: string;
    approver: Approver;
    onEvent: (event: AgentEvent) => void;
    onNotice: (text: string) => void;
  }): Promise<Runtime>;
}

interface AcpSession {
  id: string;
  root: string;
  runtime: Runtime;
  channel: SessionChannel;
  events: EventMapper;
  running?: AbortController | undefined;
}

/** JSON-RPC "internal error", with Garuda's message for the editor to show. */
const INTERNAL_ERROR = -32603;

/** The id of Garuda's Terminal Auth method (`garuda acp setup`). */
export const SETUP_METHOD_ID = "garuda-setup";

/**
 * The client can run Terminal Auth: `auth.terminal` (the spec), or the older form of the same
 * capability, `_meta["terminal-auth"]`, which Zed also sends and the ACP Registry's checker sends
 * alone (0.16.1).
 */
export function canRunTerminalAuth(
  capabilities:
    | { auth?: { terminal?: boolean }; _meta?: { [key: string]: unknown } | null }
    | undefined,
): boolean {
  return capabilities?.auth?.terminal === true || capabilities?._meta?.["terminal-auth"] === true;
}

/** An error for `createRuntime`: the setup is missing (no model, or no key for its provider). */
export function setupNeeded(message: string): Error {
  return Object.assign(new Error(message), { authRequired: true as const });
}

const MODES: Readonly<Record<AgentMode, { name: string; description: string }>> = {
  build: { name: "Build", description: "Edits and commands, each one asks first." },
  plan: {
    name: "Plan",
    description: "Reads and plans. No edits; commands cannot write the project.",
  },
};

const STOP_REASONS: Readonly<Record<AgentStopReason, StopReason>> = {
  done: "end_turn",
  max_tokens: "max_tokens",
  refusal: "refusal",
  max_steps: "max_turn_requests",
  token_budget: "max_turn_requests",
  repeated_calls: "max_turn_requests",
};

/**
 * Garuda as an ACP agent (0.15, docs/lld/acp.md). One runtime per editor session: the same
 * permission engine, sandbox, team policy, hooks and audit log as the terminal. The editor shows
 * and answers; Garuda runs the tools.
 */
export interface AcpServer {
  app: AgentApp;
  /** Serve one editor over these streams (stdio); resolves when the editor closes the connection. */
  serve(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Promise<void>;
  /** Close every session's runtime and stop its commands. */
  close(): Promise<void>;
  /** Stop every running command at once (for the exit handler, which cannot wait). */
  shutdown(): void;
}

export function acpServer(options: AcpServerOptions): AcpServer {
  const sessions = new Map<string, AcpSession>();
  const sessionOf = (id: string): AcpSession => {
    const session = sessions.get(id);
    if (session === undefined) throw RequestError.resourceNotFound(`session:${id}`);
    return session;
  };

  // The connection's client: a request's own handle closes when its response is sent, so an
  // update after a response (the commands for the "/" menu) goes through this one.
  let connection: AcpClient | undefined;
  const app = agent({ name: "garuda" })
    .onConnect((c) => {
      connection = c.client;
    })
    .onRequest(
      methods.agent.initialize,
      (c): InitializeResponse => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "garuda", title: "Garuda", version: options.version },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        // Terminal Auth (0.16) only for an editor that can run it (the spec: never offer it else).
        authMethods:
          options.terminalAuth !== undefined && canRunTerminalAuth(c.params.clientCapabilities)
            ? [
                {
                  type: "terminal",
                  id: SETUP_METHOD_ID,
                  name: "Set up Garuda",
                  description: "Choose a model and enter its API key.",
                  args: options.terminalAuth.args,
                },
              ]
            : [],
      }),
    )
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.session.new, async (c) => {
      const root = c.params.cwd;
      if (!isAbsolute(root) || !isFolder(root)) {
        throw RequestError.invalidParams(
          undefined,
          `cwd must be an absolute path to a folder: ${root}`,
        );
      }
      const id = randomUUID();
      const channel = new SessionChannel(id);
      const calls = new KnownCalls();
      const events = new EventMapper(channel, calls, root);
      let runtime: Runtime;
      try {
        runtime = await options.createRuntime({
          root,
          approver: new AcpApprover(channel, calls),
          onEvent: (event) => events.event(event),
          onNotice: (text) => channel.notice(text),
        });
      } catch (error) {
        const message = (error as Error).message;
        if ((error as { authRequired?: unknown }).authRequired === true) {
          throw RequestError.authRequired(undefined, message);
        }
        throw new RequestError(INTERNAL_ERROR, message);
      }
      if (runtime.executorNotice !== undefined) channel.notice(runtime.executorNotice);
      const skipped = editorServers(c.params.mcpServers);
      if (skipped !== undefined) channel.notice(skipped);
      sessions.set(id, { id, root, runtime, channel, events });
      // The commands for the editor's "/" menu, after the response (an update needs the session).
      setImmediate(() => {
        void connection
          ?.notify("session/update", {
            sessionId: id,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: commandsOf(runtime),
            },
          })
          .catch(() => {});
      });
      return { sessionId: id, modes: modesOf(runtime.mode) };
    })
    .onRequest(methods.agent.session.setMode, (c) => {
      const session = sessionOf(c.params.sessionId);
      const mode = c.params.modeId;
      if (mode !== "build" && mode !== "plan") {
        throw RequestError.invalidParams(undefined, `Unknown mode "${mode}": use build or plan.`);
      }
      // As in the terminal, the mode applies from the next turn.
      session.runtime.setMode(mode);
      return {};
    })
    .onNotification(methods.agent.session.cancel, (c) => {
      const session = sessions.get(c.params.sessionId);
      if (session?.running === undefined) return;
      session.channel.cancel();
      session.running.abort();
    })
    .onRequest(methods.agent.session.prompt, async (c) => {
      const session = sessionOf(c.params.sessionId);
      if (session.running !== undefined) {
        throw RequestError.invalidRequest(
          undefined,
          "A prompt is already running in this session.",
        );
      }
      const controller = new AbortController();
      session.running = controller;
      const onCancel = () => {
        session.channel.cancel();
        controller.abort();
      };
      c.signal.addEventListener("abort", onCancel, { once: true });
      session.channel.open(c.client);
      try {
        return {
          stopReason: await turn(
            session,
            promptText(c.params.prompt, session.root),
            controller.signal,
          ),
        };
      } finally {
        c.signal.removeEventListener("abort", onCancel);
        session.running = undefined;
        await session.channel.close();
      }
    });

  return {
    app,
    async serve(output, input) {
      await app.connect(ndJsonStream(output, input)).closed;
    },
    shutdown() {
      for (const session of sessions.values()) session.runtime.executor.shutdown();
    },
    async close() {
      for (const session of sessions.values()) {
        session.running?.abort();
        await session.runtime.close().catch(() => {});
        session.runtime.executor.shutdown();
      }
      sessions.clear();
    },
  };
}

/** One prompt: a command first, then the turn. */
async function turn(session: AcpSession, text: string, signal: AbortSignal): Promise<StopReason> {
  const { runtime, channel, events } = session;
  let prompt = text;
  const command = /^\/([A-Za-z0-9][\w:.-]*)(?:\s|$)/.exec(text.trim());
  if (command !== null) {
    const name = command[1] as string;
    if (BUILTIN_COMMANDS.includes(name)) {
      channel.notice(
        name === "plan"
          ? "use the editor's mode menu (Plan) for plan mode."
          : `/${name} is a terminal command; it is not available in editors yet.`,
      );
      return "end_turn";
    }
    const resolved = await runtime.resolveCommand(text.trim(), signal);
    if (resolved.kind === "denied") {
      channel.notice(resolved.message);
      return "end_turn";
    }
    if (resolved.kind === "prompt") prompt = resolved.prompt;
  }
  try {
    const result = await runtime.runTurn(prompt, signal);
    return STOP_REASONS[result.stopReason];
  } catch (error) {
    if (signal.aborted) {
      runtime.recordStop("interrupted");
      // A stopped command may report its result after the turn ended: wait for it (briefly).
      await events.settle();
      // Tell the user what the stop ended: "$ sleep 60 cancelled." per call.
      const calls = channel.takeCancelled();
      channel.notice(
        calls.length === 0
          ? "the turn was cancelled."
          : calls.map((title) => `${title} cancelled.`).join("\n"),
      );
      return "cancelled";
    }
    runtime.recordStop("error");
    throw new RequestError(INTERNAL_ERROR, (error as Error).message);
  }
}

function modesOf(current: AgentMode): SessionModeState {
  return {
    currentModeId: current,
    availableModes: (Object.keys(MODES) as AgentMode[]).map((id) => ({ id, ...MODES[id] })),
  };
}

function commandsOf(runtime: Runtime): AvailableCommand[] {
  const list: AvailableCommand[] = [];
  for (const skill of runtime.skills.filter((s) => s.userInvocable)) {
    list.push({
      name: skill.name,
      description: skill.description,
      ...(skill.argumentHint === undefined ? {} : { input: { hint: skill.argumentHint } }),
    });
  }
  for (const command of runtime.commands) {
    if (list.some((c) => c.name === command.name)) continue;
    list.push({
      name: command.name,
      description: command.description ?? `/${command.name} (${command.source} command)`,
      ...(command.argumentHint === undefined ? {} : { input: { hint: command.argumentHint } }),
    });
  }
  return list;
}

/** The notice for MCP servers that the editor sent; Garuda does not start them (0.15). */
function editorServers(servers: readonly McpServer[]): string | undefined {
  if (servers.length === 0) return undefined;
  const names = servers.map((s) => s.name).join(", ");
  return `the editor's MCP servers are not started in this version (${names}). Garuda's own MCP servers (~/.garuda/mcp.json and the project's) work as in the terminal.`;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
