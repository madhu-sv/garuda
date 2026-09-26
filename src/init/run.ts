import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest, Approver } from "../permissions/types.js";
import type { Executor } from "../sandbox/types.js";
import { type FolderKind, folderKind } from "./detect.js";
import { applyPlan, buildPlan, previewText } from "./plan.js";
import { loadToml, readAllSources } from "./sources.js";

/**
 * `garuda init` and `/init` (0.5), in three steps:
 *   1. Migrate: read other agents' files, show what goes where, and write new files after a yes.
 *   2. git: offer `git init` when the folder is not a repository.
 *   3. The init turn: a prompt for the model. In a code project it reads the code and writes or
 *      improves AGENTS.md; in an empty folder it asks what to build first.
 * Steps 1 and 2 run no model. The turn uses the normal tools, so every file write shows its diff.
 */

export interface InitContext {
  root: string;
  home: string;
  approver: Approver;
  executor: Executor;
  signal: AbortSignal;
}

export interface InitResult {
  kind: FolderKind;
  /** Lines for the user: what was written, what was skipped. */
  report: string[];
  /** The prompt for the init turn. */
  prompt: string;
}

export async function runInit(context: InitContext): Promise<InitResult> {
  const { root, home, approver, executor, signal } = context;
  const kind = folderKind(root);
  const report: string[] = [];

  await loadToml();
  const items = readAllSources({ root, home });
  const plan = buildPlan(items, { root, home, defaults: true });
  if (plan.writes.length > 0 || plan.lines.some((l) => l.target === undefined)) {
    const found = new Set(items.map((i) => i.agent));
    const question: ApprovalRequest = {
      tool: "init",
      target: { kind: "input", json: "{}" },
      preview: previewText(plan),
      isolation: executor.isolation,
      title:
        found.size > 0
          ? `Set up Garuda here, with what ${[...found].join(", ")} left?`
          : "Set up Garuda in this folder?",
      question: "Write these files?",
      choices: ["once", "deny"],
      labels: { once: "Yes, write the new files", deny: "No, write nothing" },
    };
    if (plan.writes.length === 0) {
      report.push(
        "Nothing to write:",
        ...previewText(plan)
          .split("\n")
          .map((l) => `  ${l}`),
      );
    } else if ((await approver.ask(question, signal)) === "once") {
      const written = await applyPlan(plan);
      report.push(`Wrote ${written.length} file(s): ${written.join(", ")}.`);
      const imported = plan.lines.filter((l) => l.target !== undefined && l.item.kind === "mcp");
      if (imported.some((l) => l.target?.startsWith(".garuda"))) {
        report.push(
          "Project MCP servers ask for your consent the first time, like any project server.",
        );
      }
    } else {
      report.push("Nothing written.");
    }
  }

  if (!existsSync(join(root, ".git"))) {
    const choice = await approver.ask(
      {
        tool: "init",
        target: { kind: "command", command: "git init" },
        preview: "This folder is not a git repository. Git keeps the history of your changes.",
        isolation: executor.isolation,
        title: "Run git init?",
        question: "Run it?",
        choices: ["once", "deny"],
        labels: { once: "Yes, run git init", deny: "No" },
      },
      signal,
    );
    if (choice === "once") {
      const result = await executor.run(
        "git init -q",
        {
          root,
          sandbox: false,
          writePaths: [],
          denyWritePaths: [],
          denyReadPaths: [],
          network: false,
          envAllowlist: ["PATH", "HOME"],
          timeoutMs: 30_000,
          maxOutputBytes: 5_000,
        },
        { signal },
      );
      report.push(
        result.exitCode === 0 ? "Ran git init." : `git init failed: ${result.stderr.text.trim()}`,
      );
    }
  }

  return {
    kind,
    report,
    prompt: initPrompt(
      kind,
      plan.instructions.map((i) => i.path),
    ),
  };
}

/** The prompt of the init turn. */
export function initPrompt(kind: FolderKind, otherFiles: readonly string[]): string {
  const others =
    otherFiles.length === 0
      ? ""
      : `\nThese files hold instructions for other coding agents: ${otherFiles.join(", ")}. Read them and carry over what still applies.`;
  if (kind === "code") {
    return [
      "Set up this project for coding agents (/init).",
      "Read the repository with glob, grep and read_file. Do not change any code.",
      "Then create AGENTS.md at the root, or improve it if it exists (keep what is still correct), with these sections:",
      "## Build and test: the exact commands.",
      "## Structure: the main folders and what they hold.",
      "## Conventions: style, naming and patterns that the code follows.",
      "## Notes: what an agent must know (generated files, slow tests, environment variables).",
      `Be short and specific. Write only facts that you checked in the files. Never copy secrets.${others}`,
      "At the end, say in two or three lines what you wrote.",
    ].join("\n");
  }
  const what =
    kind === "empty" ? "This folder is empty." : "This folder has files, but no code yet.";
  return [
    `${what} The user wants to start a project here (/init).`,
    "Ask the user, in one short message, what they want to build, and which language, build tool and test tool to use.",
    "Suggest a default for each. Do not create files in this turn.",
    "When the user answers, create AGENTS.md with their choices (## Stack, ## Build and test, ## Conventions),",
    `and offer to create the project skeleton.${others}`,
  ].join("\n");
}
