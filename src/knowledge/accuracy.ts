import type { ReferenceAccuracy } from "./types.js";

/** First in the result so the model and chat commands see it, including an empty or cut result. */
export function referenceWarning(result: ReferenceAccuracy): string {
  return result.approximate
    ? "Approximate: reference matching can include unrelated symbols and miss aliases or dynamic uses. Verify with a compiler or language server before a rename.\n"
    : "";
}
