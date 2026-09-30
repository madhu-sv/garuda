import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serverCallText, serverResultSummary } from "../model/serverTools.js";
import type { ToolUseBlock } from "../model/types.js";
import { displayPath, PathOutsideRootError, resolveInRoot } from "../permissions/pathGuard.js";
import type { SessionRecord } from "../session/records.js";
import { summariseCall, summariseResult } from "./renderer.js";

/**
 * /export (0.6): the conversation of a session as Markdown, to read or share. It comes from the
 * session file, so secrets are already redacted (N6). Prompts and answers are in full; each tool
 * call is one line, as in the chat. Notes that Garuda adds to a message are left out, except a
 * line for each attached file and each `!command`.
 */
export function sessionMarkdown(records: readonly SessionRecord[], sessionId: string): string {
  const out: string[] = [];
  const start = records.find((r) => r.type === "start");
  out.push(`# Garuda session ${sessionId}`, "");
  if (start?.type === "start") {
    out.push(`- Folder: ${start.root}`, `- Model: ${start.model}`, `- Started: ${when(start.t)}`);
  }
  out.push("");

  const calls = new Map<string, ToolUseBlock>();
  const turns: string[] = [];
  const undone: string[] = [];
  let answering = false;
  for (const record of records) {
    switch (record.type) {
      case "user": {
        const [prompt, ...rest] = record.message.content;
        out.push(`## You · ${when(record.t)}`, "", prompt?.type === "text" ? prompt.text : "", "");
        for (const block of rest) {
          if (block.type !== "text") continue;
          const ran =
            /^(?:<garuda_note>)?The user ran a command in the chat \(not you\):\n\$ (.*)/.exec(
              block.text,
            );
          const file = /^The user attached (?:the folder )?(\S+?)(?: \(its entries\))?:\n/.exec(
            block.text,
          );
          if (ran !== null) out.push(`> Ran ${code(ran[1] ?? "")} before this message.`, "");
          else if (file !== null) out.push(`> Attached ${file[1]}`, "");
        }
        answering = false;
        break;
      }
      case "assistant":
        if (!answering) out.push("## Garuda", "");
        answering = true;
        for (const block of record.response.content) {
          if (block.type === "text" && block.text.trim() !== "") out.push(block.text.trim(), "");
          if (block.type === "tool_use") calls.set(block.id, block);
          // Claude's web search (0.6): one line per search, with the pages as links.
          if (block.type === "server_tool_result") {
            const call = record.response.content.find(
              (b) => b.type === "server_tool_use" && b.id === block.toolUseId,
            );
            const query = call?.type === "server_tool_use" ? ` ${serverCallText(call)}` : "";
            out.push(
              `- ${code(`${block.name} (Claude)${query}`)} → ${serverResultSummary(block)}`,
              ...block.results.map((r) => `  - [${r.title.replace(/[[\]]/g, "")}](${r.url})`),
              "",
            );
          }
        }
        break;
      case "tool_results": {
        const lines: string[] = [];
        for (const block of record.message.content) {
          if (block.type !== "tool_result") continue;
          const call = calls.get(block.toolUseId);
          if (call === undefined) continue;
          const result = summariseResult(call, { content: block.content, isError: block.isError });
          const what = code([call.name, summariseCall(call)].filter((p) => p !== "").join(" "));
          lines.push(`- ${what} → ${block.isError ? `failed: ${result}` : result}`);
        }
        if (lines.length > 0) out.push(...lines, "");
        break;
      }
      case "snapshot":
        turns.push(record.prompt);
        break;
      case "undo": {
        const prompt = turns.pop();
        if (prompt !== undefined) undone.push(prompt);
        out.push(`_/undo: the turn "${prompt ?? "?"}" was taken back._`, "");
        answering = false;
        break;
      }
      case "redo": {
        const prompt = undone.pop();
        if (prompt !== undefined) turns.push(prompt);
        out.push(`_/redo: the turn "${prompt ?? "?"}" came back._`, "");
        break;
      }
      case "compaction":
        out.push("_The conversation was compacted here to fit the context window._", "");
        break;
      case "model":
        out.push(`_The model changed to ${record.model}._`, "");
        break;
      case "continue":
        out.push(
          `_The response hit the output limit; Garuda asked the model to go on (${record.maxTokens} tokens)._`,
          "",
        );
        break;
      case "end":
        if (record.stopReason !== "done") out.push(`_The turn stopped: ${record.stopReason}._`, "");
        break;
      case "start":
      case "resume":
      case "title":
      case "thinking":
        break;
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Inline code that may hold backticks. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** "2026-09-26 10:15" in local time. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Write the Markdown to `file` in the root (default: garuda-<session id>.md). It never overwrites
 * a file and never writes outside the root. Gives the shown path, or a problem.
 */
export async function writeExport(
  root: string,
  sessionId: string,
  markdown: string,
  file = "",
): Promise<{ path: string } | { problem: string }> {
  const name = file === "" ? `garuda-${sessionId}.md` : file;
  let absolute: string;
  try {
    absolute = await resolveInRoot(root, name);
  } catch (error) {
    if (error instanceof PathOutsideRootError) {
      return { problem: `${name} is outside the working folder.` };
    }
    throw error;
  }
  try {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, markdown, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      problem:
        code === "EEXIST"
          ? `${displayPath(root, absolute)} already exists. Give another name: /export <file>.`
          : `Cannot write ${displayPath(root, absolute)}: ${(error as Error).message}`,
    };
  }
  return { path: displayPath(root, absolute) };
}
