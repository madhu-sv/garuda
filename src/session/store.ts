import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
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
  read(sessionId: string): Promise<SessionRecord[]>;
  /** The most recently written session, or undefined. */
  latest(): Promise<string | undefined>;
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
    return join(this.dir, `${sessionId}.jsonl`);
  }

  open(sessionId: string): Journal {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(sessionId);
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

  async latest(): Promise<string | undefined> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      return undefined;
    }
    let best: { id: string; mtime: number } | undefined;
    for (const name of names) {
      const mtime = (await stat(join(this.dir, name))).mtimeMs;
      if (best === undefined || mtime > best.mtime) best = { id: basename(name, ".jsonl"), mtime };
    }
    return best?.id;
  }
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
