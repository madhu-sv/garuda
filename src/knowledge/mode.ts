/**
 * How much of the code index the model sees (the chat commands /where, /refs, /map always work).
 *   off:    no index tools. The default: the A/B eval (hard suite, 3 runs per arm) showed the
 *           full tool set cost more tokens than it saved.
 *   lookup: find_symbol and find_references: targeted questions ("who uses X").
 *   all:    lookup plus repo_map.
 */
export type CodeIndexMode = "off" | "lookup" | "all";

export const CODE_INDEX_MODES: readonly CodeIndexMode[] = ["off", "lookup", "all"];

export const DEFAULT_CODE_INDEX_MODE: CodeIndexMode = "off";
