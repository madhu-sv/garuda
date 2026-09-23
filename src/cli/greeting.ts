import { VERSION } from "../version.js";

/** The text that `garuda` prints when you run it with no task. */
export function greeting(): string {
  return [
    `Garuda ${VERSION} — a terminal coding agent.`,
    "",
    "Hello! Give me a task:",
    '  garuda -p "Explain what this repo does" --model <model-id>',
    "",
    "Run garuda --help for all options.",
    "",
  ].join("\n");
}

/** Error text with its cause chain, so network errors show the real reason. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === "string" ? `${current.message} (${code})` : current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n  caused by: ");
}
