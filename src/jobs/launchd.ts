import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** The agent's plist: the login shell runs `garuda run <id> --from-launchd` in the project. */
export function agentPlist(job: Job, env: AgentEnv, when: Date): string {
  // The single binary (Node SEA) is its own program: no script after it.
  const program =
    env.script === "" || env.script === env.node
      ? shellWord(env.node)
      : `${shellWord(env.node)} ${shellWord(env.script)}`;
  const command = `cd ${shellWord(job.root)} && exec ${program} run ${shellWord(job.id)} --from-launchd`;
  const args = ["/usr/bin/caffeinate", "-i", env.shell, "-lic", command];
  const log = join(job.root, JOBS_DIR, `${job.id}.log`);
  const int = (key: string, value: number) => `      <key>${key}</key><integer>${value}</integer>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${xml(agentLabel(job.id))}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    ...args.map((a) => `      <string>${xml(a)}</string>`),
    "    </array>",
    `    <key>WorkingDirectory</key><string>${xml(job.root)}</string>`,
    "    <key>StartCalendarInterval</key>",
    "    <dict>",
    int("Month", when.getMonth() + 1),
    int("Day", when.getDate()),
    int("Hour", when.getHours()),
    int("Minute", when.getMinutes()),
    "    </dict>",
    "    <key>RunAtLoad</key><false/>",
    `    <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `    <key>StandardErrorPath</key><string>${xml(log)}</string>`,
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
  const when = nextTime(job.at, now);
  const plist = agentPath(env.home, job.id);
  await mkdir(join(env.home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(plist, agentPlist(job, env, when), { mode: 0o644 });
  // An agent of an earlier try: unload it first (no error when there is none).
  await hostCommand(
    executor,
    job.root,
    ["launchctl", "bootout", `gui/${env.uid}/${agentLabel(job.id)}`],
    {
      check: false,
    },
  );
  await hostCommand(executor, job.root, ["launchctl", "bootstrap", `gui/${env.uid}`, plist]);
  return { plist, when };
}

/**
 * Remove the job's agent: delete the plist, then unload it. When the job itself runs from the agent,
 * the unload ends this process too, so it must be the last step.
 */
export async function removeAgent(executor: Executor, job: Job, env: AgentEnv): Promise<boolean> {
  const plist = agentPath(env.home, job.id);
  const had = existsSync(plist);
  await rm(plist, { force: true });
  const out = await hostCommand(
    executor,
    job.root,
    ["launchctl", "bootout", `gui/${env.uid}/${agentLabel(job.id)}`],
    { check: false },
  );
  return had || out.exitCode === 0;
}
