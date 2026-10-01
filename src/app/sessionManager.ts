import type { Approver } from "../permissions/types.js";
import type { Isolation } from "../sandbox/types.js";
import { cleanTitle, type SessionSummary, summariseSession } from "../session/list.js";
import type { SessionStore } from "../session/store.js";

/** A number from the /sessions list, a session id, or the unique start of one. */
export async function findSession(ref: string, store: SessionStore): Promise<string | undefined> {
  const all = await store.list();
  return /^\d+$/.test(ref)
    ? all[Number(ref) - 1]?.id
    : (all.find((s) => s.id === ref) ?? onlyOne(all.filter((s) => s.id.startsWith(ref))))?.id;
}

export async function listSessions(
  store: SessionStore,
  max = 20,
): Promise<{ sessions: SessionSummary[]; total: number }> {
  const all = await store.list();
  const sessions: SessionSummary[] = [];
  for (const { id, updated } of all.slice(0, max)) {
    const records = await store.read(id).catch(() => undefined);
    if (records !== undefined) sessions.push(summariseSession(id, updated, records));
  }
  return { sessions, total: all.length };
}

export async function renameSession(
  ref: string,
  title: string,
  store: SessionStore,
): Promise<{ ok: boolean; text: string }> {
  const id = await findSession(ref, store);
  if (id === undefined) {
    return { ok: false, text: `There is no session "${ref}" in this project. Type /sessions.` };
  }
  const clean = cleanTitle(title);
  if (clean === "") return { ok: false, text: "Give a title: /sessions rename <n|id> <title>." };
  await store.setTitle(id, clean);
  return { ok: true, text: `Session ${id} is now "${clean}".` };
}

export async function deleteSession(
  ref: string,
  signal: AbortSignal,
  store: SessionStore,
  currentSessionId: string | undefined,
  approver: Approver,
  isolation: Isolation,
): Promise<{ ok: boolean; text: string }> {
  const id = await findSession(ref, store);
  if (id === undefined) {
    return { ok: false, text: `There is no session "${ref}" in this project. Type /sessions.` };
  }
  if (id === currentSessionId) {
    return {
      ok: false,
      text: `Session ${id} is open. Start a new one (/new) or open another first.`,
    };
  }
  const records = await store.read(id);
  const summary = summariseSession(id, new Date(), records);
  const choice = await approver.ask(
    {
      tool: "sessions",
      target: { kind: "input", json: "{}" },
      preview: [
        `Session ${id}`,
        `"${summary.title}" · ${summary.turns} turn${summary.turns === 1 ? "" : "s"}`,
        "The file and its subagent logs go for good. /undo cannot bring them back.",
      ].join("\n"),
      isolation,
      title: "Delete a session?",
      question: "Delete it?",
      choices: ["once", "deny"],
      labels: { once: "Yes, delete it", deny: "No" },
    },
    signal,
  );
  if (choice === "deny") return { ok: true, text: "Nothing changed." };
  await store.remove(id);
  return { ok: true, text: `Session ${id} is deleted.` };
}

export function onlyOne<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
