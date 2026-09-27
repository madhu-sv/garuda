import type { Job } from "./job.js";

/** The task of a job: the user's request, the plan, and the rules of an unattended run (0.7). */
export function jobPrompt(request: string, plan: string): string {
  return [
    "Carry out the plan below. It was made in an earlier session; you now run as a scheduled job, and nobody can answer questions or approve calls.",
    "- Calls outside the job's approved list are denied. Do not retry a denied call: continue without it, and list it at the end.",
    "- Do not commit, push or change branches: Garuda commits your changes to the job's branch when you finish.",
    "- Run the project's tests when the plan says how. End with a short report: what you changed, the test result, and what is left for the user.",
    "",
    "<request>",
    request.trim(),
    "</request>",
    "",
    "<plan>",
    plan.trim(),
    "</plan>",
  ].join("\n");
}

const cost = (usd: number | undefined) => (usd === undefined ? "unknown" : `$${usd.toFixed(4)}`);

/** The job report (Markdown): for the terminal, the report file and /jobs <id>. */
export function jobReport(job: Job): string {
  const r = job.result;
  const lines = [`# Garuda job ${job.id}: ${job.title}`, ""];
  lines.push(
    `- Status: ${job.status}${r === undefined ? "" : ` (${r.stopReason})`}`,
    `- Branch: ${job.branch} (worktree ${job.worktree})`,
    `- Base: ${job.base.slice(0, 12)}`,
    `- Approved: ${job.allow.length === 0 ? "nothing beyond the sandbox" : job.allow.join(", ")}`,
  );
  if (job.startedAt !== undefined) lines.push(`- Started: ${job.startedAt}`);
  if (r === undefined) return lines.join("\n");
  lines.push(
    `- Steps: ${r.steps} · tokens: ${Math.round(r.tokens / 100) / 10}k · cost: ${cost(r.costUsd)} · time: ${Math.round(r.durationMs / 1000)} s`,
  );
  if (r.sessionId !== undefined) lines.push(`- Session: ${r.sessionId}`);
  if (r.error !== undefined) lines.push(`- Error: ${r.error}`);
  lines.push("", "## Files");
  if (r.files.length === 0) lines.push("", "No file changed.");
  else {
    lines.push("");
    for (const f of r.files) {
      const counts = f.added === undefined ? " (binary)" : ` (+${f.added} −${f.removed ?? 0})`;
      lines.push(`- ${f.status} ${f.path}${counts}`);
    }
  }
  if (r.denied.length > 0) {
    lines.push(
      "",
      "## Denied calls",
      "",
      "The job's list did not cover these; do them yourself or add rules and run again:",
      "",
    );
    for (const d of r.denied) lines.push(`- ${d.tool}: ${d.target}`);
  }
  if (r.answer.trim() !== "") lines.push("", "## The agent's report", "", r.answer.trim());
  lines.push(
    "",
    "## Next",
    "",
    r.commit === undefined
      ? "Nothing to merge."
      : `Review: \`git diff ${job.base.slice(0, 12)} ${job.branch}\` · merge: \`git merge ${job.branch}\` · clean up: \`git worktree remove ${job.worktree}\``,
  );
  return lines.join("\n");
}
