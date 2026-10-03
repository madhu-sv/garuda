import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NewRecord, SessionRecord } from "./records.js";
import { Redactor } from "./redact.js";

/** Writes the records of one session, in order. */
export interface Journal {
  write(record: NewRecord): void;
}

/**
 * Where sessions live. 0.1 ships FileSessionStore (one JSONL file per session).
 * A shared store (for example Redis) can implement the same interface later.
 */
export interface SessionStore {
  open(sessionId: string): Journal;
  /**
   * The journal of a subagent run (0.3), kept with its parent session. It is not a session of its
   * own: `latest()` never returns it, so --resume never picks it.
   */
  openChild(sessionId: string, childId: string): Journal;
  read(sessionId: string): Promise<SessionRecord[]>;
  /** The most recently written session, or undefined. */
  latest(): Promise<string | undefined>;
  /** The sessions of this project, newest first (0.6, /sessions). */
  list(): Promise<{ id: string; updated: Date }[]>;
  /** Give a session a title (0.8, /sessions rename). Its place in the list does not change. */
  setTitle(sessionId: string, title: string): Promise<void>;
  /** Delete a session and its subagent journals for good (0.8, /sessions delete). */
  remove(sessionId: string): Promise<void>;
}

export const SESSIONS_DIR = join(".garuda", "sessions");

/**
 * `.garuda/sessions/<id>.jsonl` in the working root. Each write is one appended line,
 * written at once, so a crash loses at most the line in progress.
 * Every string is redacted before it reaches the disk (N6). Files are private to the user (0600).
 */
export class FileSessionStore implements SessionStore {
  readonly dir: string;
  private readonly redactor: Redactor;

  constructor(root: string, redactor: Redactor = new Redactor()) {
    this.dir = join(root, SESSIONS_DIR);
    this.redactor = redactor;
  }

  path(sessionId: string): string {
    // `--resume ../x` must not read or append outside .garuda/sessions (0.14, review).
    if (!SESSION_ID.test(sessionId)) throw new Error(`"${sessionId}" is not a session id.`);
    return join(this.dir, `${sessionId}.jsonl`);
  }

  open(sessionId: string): Journal {
    return this.journal(this.dir, this.path(sessionId));
  }

  /** `.garuda/sessions/<session id>/<child id>.jsonl`. */
  childPath(sessionId: string, childId: string): string {
    return join(this.dir, safeId(sessionId), `${safeId(childId)}.jsonl`);
  }

  openChild(sessionId: string, childId: string): Journal {
    return this.journal(join(this.dir, safeId(sessionId)), this.childPath(sessionId, childId));
  }

  private journal(dir: string, file: string): Journal {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      write: (record) => {
        const line = { t: new Date().toISOString(), ...record };
        appendFileSync(file, `${JSON.stringify(this.redactor.value(line))}\n`, { mode: 0o600 });
      },
    };
  }

  async read(sessionId: string): Promise<SessionRecord[]> {
    return parseRecords(await readFile(this.path(sessionId), "utf8"));
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    const file = this.path(sessionId);
    const before = await stat(file);
    this.open(sessionId).write({ type: "title", title });
    // Keep the file time: the list sorts by the last work, and a new title is not work.
    await utimes(file, before.atime, before.mtime);
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.path(sessionId));
    await rm(join(this.dir, safeId(sessionId)), { recursive: true, force: true });
  }

  async latest(): Promise<string | undefined> {
    return (await this.list())[0]?.id;
  }

  async list(): Promise<{ id: string; updated: Date }[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: { id: string; updated: Date }[] = [];
    for (const name of names) {
      const info = await stat(join(this.dir, name)).catch(() => undefined);
      if (info?.isFile()) out.push({ id: basename(name, ".jsonl"), updated: info.mtime });
    }
    return out.sort((a, b) => b.updated.getTime() - a.updated.getTime());
  }
}

/** An id as a file name: tool call ids come from the model provider, so keep only safe characters. */
/** The characters of a session id (newSessionId gives digits, "-" and hex). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "_";
}

/** Parse a session file. A broken last line (a crash during a write) is skipped. */
export function parseRecords(text: string): SessionRecord[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const records: SessionRecord[] = [];
  lines.forEach((line, i) => {
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch (error) {
      if (i < lines.length - 1) throw new Error(`Session file line ${i + 1} is not valid JSON.`);
      void error;
    }
  });
  return records;
}

/** A session id that sorts by time: 20260923-201500-a1b2. */
export function newSessionId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/** A journal that keeps records in memory. Tests use it. */
export class MemoryJournal implements Journal {
  readonly records: SessionRecord[] = [];

  write(record: NewRecord): void {
    this.records.push(structuredClone({ t: new Date().toISOString(), ...record }) as SessionRecord);
  }
}
