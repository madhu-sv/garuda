import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** The longest embedded resource (a selection, an open file) that goes into the prompt. */
export const EMBEDDED_MAX_CHARS = 100_000;

/**
 * The editor's prompt as Garuda's prompt text (ACP, 0.15).
 *
 * - text: as is.
 * - resource_link to a file in the root: `@<path>`, so Garuda's mention code attaches it with
 *   read_file's checks (deny rules, the team policy, links). Other links stay text.
 * - resource (embedded context): a fenced block labelled with its URI. It is text that the user
 *   sent, like a paste.
 * - image and audio: Garuda does not offer them; a note says so if an editor sends one.
 */
export function promptText(blocks: readonly ContentBlock[], root: string): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link":
        parts.push(linkText(block.uri, block.name, root));
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          const text =
            resource.text.length <= EMBEDDED_MAX_CHARS
              ? resource.text
              : `${resource.text.slice(0, EMBEDDED_MAX_CHARS)}\n[Garuda: cut at ${EMBEDDED_MAX_CHARS} characters]`;
          parts.push(`${resource.uri}:\n${fence(text)}`);
        } else {
          parts.push(`[Garuda: ${resource.uri} is binary; it was not attached]`);
        }
        break;
      }
      default:
        parts.push(`[Garuda: a ${block.type} block was not attached; Garuda takes text only]`);
    }
  }
  return parts.join("\n\n");
}

/** `@path` for a file in the root (no spaces: the mention syntax ends at white space). */
function linkText(uri: string, name: string, root: string): string {
  let path: string | undefined;
  try {
    path = uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    path = undefined;
  }
  if (path !== undefined) {
    const inner = relative(root, path);
    const inside = inner !== "" && !inner.startsWith("..") && !isAbsolute(inner);
    if (inside && !/\s/.test(inner)) return `@${inner.split(sep).join("/")}`;
  }
  return `${name} (${uri})`;
}

/** A Markdown fence that the text cannot close: one backtick more than its longest run. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const mark = "`".repeat(longest + 1);
  return `${mark}\n${text}\n${mark}`;
}
