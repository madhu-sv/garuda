import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Executor } from "../sandbox/types.js";
import { hostCommand, shellWord } from "./git.js";
import { JOBS_DIR, type Job } from "./job.js";

/**
 * A launchd agent for a job (0.7, macOS): the job runs at its time also when no terminal is open.
 * The agent starts the user's login shell (so .zprofile and .zshrc set the API keys, as in a
 * terminal; no key is written to a file) under `caffeinate -i` (no idle sleep during the run). It
 * fires once, on the job's date; the job removes the agent when it ends. If the Mac sleeps at that
 * time, launchd starts the job at the next wake.
 */

export interface AgentEnv {
  home: string;
  /** The user id for `launchctl bootstrap gui/<uid>`. */
  uid: number;
  /** The login shell: zsh or bash; default /bin/zsh. */
  shell: string;
  /** The node binary and Garuda's CLI script, as absolute paths. */
  node: string;
  script: string;
}

export function defaultAgentEnv(): AgentEnv {
  const shell = process.env.SHELL ?? "";
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 501,
    shell: /\/(zsh|bash)$/.test(shell) ? shell : "/bin/zsh",
    node: process.execPath,
    script: process.argv[1] ?? "",
  };
}

export function agentLabel(id: string): string {
  return `dev.garuda.job.${id}`;
}

export function agentPath(home: string, id: string): string {
  return join(home, "Library", "LaunchAgents", `${agentLabel(id)}.plist`);
}

/** The next hh:mm in local time, today or tomorrow. */
export function nextTime(at: string, now: Date = new Date()): Date {
  const [hour, minute] = at.split(":").map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What an agent starts (0.11): a label, the project, Garuda's arguments, the log. */
export interface AgentSpec {
  label: string;
  root: string;
  args: string[];
  log: string;
}

/** The job's agent: `garuda run <id> --from-launchd`. */
export function jobSpec(job: Pick<Job, "id" | "root">): AgentSpec {
  return {
    label: agentLabel(job.id),
    root: job.root,
    args: ["run", job.id, "--from-launchd"],
    log: join(job.root, JOBS_DIR, `${job.id}.log`),
  };
}

/** The night queue's agent (0.11): `garuda night --from-launchd`, one per project. */
export function nightSpec(root: string): AgentSpec {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const name =
    basename(root)
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 40) || "project";
  return {
    label: `dev.garuda.night.${name}-${hash}`,
    root,
    args: ["night", "--from-launchd"],
    log: join(root, JOBS_DIR, "night.log"),
  };
}

export function specPath(home: string, spec: AgentSpec): string {
  return join(home, "Library", "LaunchAgents", `${spec.label}.plist`);
}

/** The agent's plist: the login shell runs `garuda run <id> --from-launchd` in the project. */
export function agentPlist(job: Pick<Job, "id" | "root">, env: AgentEnv, when: Date): string {
  return specPlist(jobSpec(job), env, when);
}

/** A plist for any agent: the login shell runs Garuda with `spec.args` in the project. */
export function specPlist(spec: AgentSpec, env: AgentEnv, when: Date): string {
  // The single binary (Node SEA) is its own program: no script after it.
  const program =
    env.script === "" || env.script === env.node
      ? shellWord(env.node)
      : `${shellWord(env.node)} ${shellWord(env.script)}`;
  const command = `cd ${shellWord(spec.root)} && exec ${program} ${spec.args.map(shellWord).join(" ")}`;
  const args = ["/usr/bin/caffeinate", "-i", env.shell, "-lic", command];
  const int = (key: string, value: number) => `      <key>${key}</key><integer>${value}</integer>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${xml(spec.label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    ...args.map((a) => `      <string>${xml(a)}</string>`),
    "    </array>",
    `    <key>WorkingDirectory</key><string>${xml(spec.root)}</string>`,
    "    <key>StartCalendarInterval</key>",
    "    <dict>",
    int("Month", when.getMonth() + 1),
    int("Day", when.getDate()),
    int("Hour", when.getHours()),
    int("Minute", when.getMinutes()),
    "    </dict>",
    "    <key>RunAtLoad</key><false/>",
    `    <key>StandardOutPath</key><string>${xml(spec.log)}</string>`,
    `    <key>StandardErrorPath</key><string>${xml(spec.log)}</string>`,
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Write the plist and load it. Returns the date and time launchd starts the job. */
export async function installAgent(
  executor: Executor,
  job: Job,
  env: AgentEnv,
  now: Date = new Date(),
): Promise<{ plist: string; when: Date }> {
  if (job.at === undefined) throw new Error("The job has no time.");
  return installSpec(executor, jobSpec(job), env, nextTime(job.at, now));
}

/** Write any agent's plist and load it (an earlier one of the same label is unloaded first). */
export async function installSpec(
  executor: Executor,
  spec: AgentSpec,
  env: AgentEnv,
  when: Date,
): Promise<{ plist: string; when: Date }> {
  const plist = specPath(env.home, spec);
  await mkdir(join(env.home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(plist, specPlist(spec, env, when), { mode: 0o644 });
  // An agent of an earlier try: unload it first (no error when there is none).
  await hostCommand(executor, spec.root, ["launchctl", "bootout", `gui/${env.uid}/${spec.label}`], {
    check: false,
  });
  await hostCommand(executor, spec.root, ["launchctl", "bootstrap", `gui/${env.uid}`, plist]);
  return { plist, when };
}

/** Remove any agent: delete the plist, then unload it (the last step when it runs this process). */
export async function removeSpec(
  executor: Executor,
  spec: AgentSpec,
  env: AgentEnv,
): Promise<boolean> {
  const plist = specPath(env.home, spec);
  const had = existsSync(plist);
  await rm(plist, { force: true });
  const out = await hostCommand(
    executor,
    spec.root,
    ["launchctl", "bootout", `gui/${env.uid}/${spec.label}`],
    { check: false },
  );
  return had || out.exitCode === 0;
}

/** When the night queue's agent starts (read from its plist), or undefined when there is none. */
export function nightAgentTime(root: string, env: Pick<AgentEnv, "home">): Date | undefined {
  let text: string;
  try {
    text = readFileSync(specPath(env.home, nightSpec(root)), "utf8");
  } catch {
    return undefined;
  }
  const n = (key: string) =>
    Number(new RegExp(`<key>${key}</key><integer>(\\d+)</integer>`).exec(text)?.[1]);
  const month = n("Month");
  const day = n("Day");
  if (Number.isNaN(month) || Number.isNaN(day)) return undefined;
  const now = new Date();
  const when = new Date(now.getFullYear(), month - 1, day, n("Hour"), n("Minute"));
  // A date early in the year for an agent made in December: next year.
  if (when.getTime() < now.getTime() - 180 * 86_400_000) when.setFullYear(now.getFullYear() + 1);
  return when;
}

/**
 * Remove the job's agent: delete the plist, then unload it. When the job itself runs from the agent,
 * the unload ends this process too, so it must be the last step.
 */
export async function removeAgent(executor: Executor, job: Job, env: AgentEnv): Promise<boolean> {
  return removeSpec(executor, jobSpec(job), env);
}
