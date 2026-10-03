import { createHash } from "node:crypto";
import { cleanLine } from "../mcp/sanitize.js";
import type { TrustStore } from "../mcp/trust.js";
import type { Isolation } from "../sandbox/types.js";
import { formatRule } from "./rules.js";
import type { Settings } from "./settings.js";
import type { ApprovalChoice, ApprovalRequest } from "./types.js";

/**
 * Consent for the project's own settings (review finding, 2026-10-03). `.garuda/settings.json` comes
 * with the repository, so a cloned repo could turn off its own safety:
 * `{"executor":"host","permissions":{"allow":["bash"]}}` ran every command on the host with no
 * question, and `"sandbox":{"writePaths":["~"]}` made the home folder writable.
 *
 * Only the parts that loosen safety need consent; everything else (deny rules, features, limits)
 * applies as before. Until the user approves, the loosening parts are left out. An approval can be
 * pinned in ~/.garuda/trust.json to a hash of those parts, like MCP servers and the network list.
 */

/** The parts of the settings that loosen safety, in a stable form for the hash and the question. */
export interface SettingsRisk {
  executorHost: boolean;
  allow: string[];
  writePaths: string[];
  envAllow: string[];
  allowLocalhost: boolean;
  /**
   * Formatter commands that the project defines (0.14.1, review): they run after every edit, so
   * they are commands like a hook's. Each as "name: command words".
   */
  formatterCommands?: string[];
}

export function settingsRisk(settings: Settings): SettingsRisk | undefined {
  const risk: SettingsRisk = {
    executorHost: settings.executor === "host",
    allow: settings.allow.map(formatRule),
    writePaths: [...(settings.sandbox?.writePaths ?? [])],
    envAllow: [...settings.envAllow],
    allowLocalhost: settings.web?.allowLocalhost === true,
  };
  const formatterCommands = Object.entries(settings.formatters?.commands ?? {}).flatMap(
    ([name, f]) => (f === false ? [] : [`${name}: ${f.command.join(" ")}`]),
  );
  // Only when present, so the hash of settings without them (pinned before 0.14.1) stays the same.
  if (formatterCommands.length > 0) risk.formatterCommands = formatterCommands;
  const none =
    !risk.executorHost &&
    risk.allow.length === 0 &&
    risk.writePaths.length === 0 &&
    risk.envAllow.length === 0 &&
    !risk.allowLocalhost &&
    risk.formatterCommands === undefined;
  return none ? undefined : risk;
}

export function settingsRiskHash(risk: SettingsRisk): string {
  return createHash("sha256").update(JSON.stringify(risk)).digest("hex");
}

/** One line per loosening part, for the question and the notice. */
export function settingsRiskLines(risk: SettingsRisk): string[] {
  const lines: string[] = [];
  if (risk.executorHost) lines.push('executor: "host" (commands run with no OS sandbox)');
  if (risk.allow.length > 0) {
    lines.push(`permissions.allow (no question for these): ${risk.allow.join(", ")}`);
  }
  if (risk.writePaths.length > 0) {
    lines.push(`sandbox.writePaths (commands may write there): ${risk.writePaths.join(", ")}`);
  }
  if (risk.envAllow.length > 0) {
    lines.push(`env.allow (commands see these variables): ${risk.envAllow.join(", ")}`);
  }
  if (risk.allowLocalhost) lines.push("web.allowLocalhost (web_fetch may reach this machine)");
  if (risk.formatterCommands !== undefined) {
    lines.push(
      `formatters.commands (run after each edit): ${risk.formatterCommands.map(cleanLine).join("; ")}`,
    );
  }
  return lines;
}

/** The settings without the parts that loosen safety. */
export function withoutRisk(settings: Settings): Settings {
  const { sandbox, web, formatters, ...rest } = settings;
  const { writePaths: _writePaths, ...sandboxRest } = sandbox ?? {};
  // Keep "name": false (turns a built-in formatter off); drop the project's own commands.
  const keptCommands = Object.fromEntries(
    Object.entries(formatters?.commands ?? {}).filter(([, f]) => f === false),
  );
  return {
    ...rest,
    ...(formatters === undefined ? {} : { formatters: { ...formatters, commands: keptCommands } }),
    executor: settings.executor === "host" ? "auto" : settings.executor,
    allow: [],
    envAllow: [],
    ...(sandbox === undefined ? {} : { sandbox: sandboxRest }),
    ...(web === undefined ? {} : { web: { ...web, allowLocalhost: false } }),
  };
}

export interface GateOptions {
  root: string;
  settings: Settings;
  /** Where approvals are pinned. Absent: nothing is pinned, so the loosening parts stay off. */
  trust?: TrustStore | undefined;
  /** Asks the user. Absent (no terminal, a job, -p from a pipe): the loosening parts stay off. */
  ask?: ((request: ApprovalRequest) => Promise<ApprovalChoice>) | undefined;
  isolation?: Isolation;
}

export interface GateResult {
  settings: Settings;
  /** Set when parts were left out: says what and how to turn them on. */
  notice?: string;
}

/** The project's settings, with the loosening parts only when the user approved them. */
export async function gateProjectSettings(options: GateOptions): Promise<GateResult> {
  const risk = settingsRisk(options.settings);
  if (risk === undefined) return { settings: options.settings };
  const hash = settingsRiskHash(risk);
  const known = options.trust?.settingsHash(options.root);
  if (known === hash) return { settings: options.settings };

  const lines = settingsRiskLines(risk);
  if (options.ask !== undefined) {
    const choice = await options.ask({
      tool: "settings",
      target: { kind: "input", json: "" },
      title: "Project settings that loosen safety",
      preview: [
        `This project's .garuda/settings.json ${known === undefined ? "asks for" : "changed and now asks for"}:`,
        ...lines.map((line) => `  - ${line}`),
        "A cloned repository can ship this file. Without your yes, Garuda uses safe defaults for these",
        "parts; the rest of the file applies.",
      ].join("\n"),
      isolation: options.isolation ?? "os",
      question: "Use these project settings?",
      choices: ["once", "session", "deny"],
      labels: {
        once: "Yes, for this run",
        session: "Yes, and remember (asks again when they change)",
        deny: "No, use safe defaults",
      },
    });
    if (choice === "session") await options.trust?.setSettingsHash(options.root, hash);
    if (choice !== "deny") return { settings: options.settings };
  }
  return {
    settings: withoutRisk(options.settings),
    notice: [
      `Project settings not applied (not approved): ${lines.join("; ")}.`,
      "Start the chat in a terminal and answer yes to use them.",
    ].join(" "),
  };
}
