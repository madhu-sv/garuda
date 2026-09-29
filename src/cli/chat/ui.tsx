import { Box, Static, Text, useInput, usePaste } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { focusEvent } from "../focus.js";
import { PALETTE_ROWS, type PaletteState, paletteWindow } from "./palette.js";
import type { ChatState, ChatStore, Item } from "./store.js";

/**
 * The Ink view of the chat (0.2). It draws the store and maps keys to store actions.
 * Finished items print once into the scrollback (<Static>); the live part stays small.
 */
export function App({ store }: { store: ChatStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useInput((input, key) => onKey(store, state, input, key));
  // Bracketed paste: pasted text (new lines too) goes into the line and is never sent.
  usePaste((text) => {
    if (store.getState().approval === undefined) store.editLine({ type: "insert", text });
  });
  const spinning = state.busy && state.approval === undefined;
  const frame = useSpinner(spinning);

  return (
    <>
      <Static items={state.items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      <Box flexDirection="column">
        {state.streaming !== "" && <Text>{state.streaming}</Text>}
        {state.running.map((tool) => (
          <Text key={tool.id}>
            <Text color="cyan">{frame}</Text> {tool.line}
          </Text>
        ))}
        {spinning && state.running.length === 0 && state.streaming === "" && (
          <Text dimColor>
            <Text color="cyan">{frame}</Text> Working… (Ctrl-C stops)
          </Text>
        )}
        {state.approval !== undefined && (
          <ApprovalView
            question={state.approval.request.question ?? "Allow?"}
            choices={state.approval.choices}
            selected={state.approval.selected}
          />
        )}
        {state.queue.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: queued lines can repeat.
          <Text key={i} dimColor>
            {"  "}queued: {firstLine(line)}
          </Text>
        ))}
        {state.approval === undefined && !state.exiting && state.palette !== undefined && (
          <PaletteView palette={state.palette} />
        )}
        {state.approval === undefined && !state.exiting && state.palette === undefined && (
          <InputLine state={state} />
        )}
        <Footer state={state} />
      </Box>
    </>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text bold>› {item.text}</Text>
        </Box>
      );
    case "text":
      return (
        <Box marginTop={1}>
          <Text>{item.text}</Text>
        </Box>
      );
    default:
      return <Text>{item.text}</Text>;
  }
}

function ApprovalView({
  question,
  choices,
  selected,
}: {
  question: string;
  choices: { choice: string; label: string }[];
  selected: number;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{question}</Text>
      {choices.map((c, i) => (
        <Text key={c.choice} {...(i === selected ? { color: "cyan" } : {})}>
          {i === selected ? "❯ " : "  "}
          {i + 1}. {c.label}
        </Text>
      ))}
      <Text dimColor>{approvalKeys(choices.map((c) => c.choice))}</Text>
    </Box>
  );
}

/** The key hint under the choices: numbers, and the letter for each choice shown. */
export function approvalKeys(choices: readonly string[]): string {
  const letters: Record<string, string> = { once: "y", session: "a", deny: "n or Esc" };
  const numbers = choices.map((_, i) => i + 1).join(" ");
  const keys = choices.map((c, i) => `${letters[c] ?? "?"} = ${i + 1}`).join(" · ");
  return `↑↓ and Enter, or ${numbers} · ${keys}`;
}

function PaletteView({ palette }: { palette: PaletteState }) {
  const first = paletteWindow(palette.selected, palette.entries.length);
  const rows = palette.entries.slice(first, first + PALETTE_ROWS);
  const width = Math.max(8, ...rows.map((e) => e.name.length + 1));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan">Command › </Text>
        {palette.query}
        <Text inverse> </Text>
      </Text>
      {rows.length === 0 && <Text dimColor> No command matches.</Text>}
      {rows.map((entry, i) => {
        const selected = first + i === palette.selected;
        return (
          <Text key={entry.name} {...(selected ? { color: "cyan" } : {})}>
            {selected ? "❯ " : "  "}
            {`/${entry.name}`.padEnd(width + 1)}
            <Text dimColor>{entry.hint}</Text>
          </Text>
        );
      })}
      <Text dimColor>
        {palette.entries.length > PALETTE_ROWS
          ? `${palette.selected + 1} of ${palette.entries.length} · `
          : ""}
        type to filter · ↑↓ · Enter picks · Esc closes
      </Text>
    </Box>
  );
}

function InputLine({ state }: { state: ChatState }) {
  const { text, cursor } = state.editor;
  const at = text[cursor];
  return (
    <Box marginTop={1}>
      <Text>
        <Text color="cyan">› </Text>
        {text.slice(0, cursor)}
        <Text inverse>{at === undefined || at === "\n" ? " " : at}</Text>
        {at === "\n" ? "\n" : ""}
        {text.slice(cursor + 1)}
      </Text>
    </Box>
  );
}

function Footer({ state }: { state: ChatState }) {
  const { model, sandbox, contextPercent, costUsd, mode } = state.status;
  const parts = [model, sandbox];
  if (contextPercent !== undefined) parts.push(`context ${contextPercent}%`);
  if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`);
  const keys = state.busy
    ? "Esc stop · Ctrl-O output"
    : "\\ then Enter: new line · Ctrl-G editor · Ctrl-P commands";
  return (
    <Text>
      {mode === "plan" ? (
        <Text color="yellow" bold>
          PLAN{" "}
        </Text>
      ) : null}
      <Text dimColor>
        {parts.join(" · ")} {"  "}
        {keys}
      </Text>
    </Text>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);
  return FRAMES[i] ?? "⠋";
}

const firstLine = (text: string) => {
  const [first = "", ...rest] = text.split("\n");
  return rest.length > 0 ? `${first} …` : first;
};

/** The keys that Ink reports. */
export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  tab: boolean;
  shift?: boolean;
  backspace: boolean;
  delete: boolean;
}

/** Keys to store actions. Exported for tests. */
export function onKey(store: ChatStore, state: ChatState, input: string, key: Key): void {
  // Focus reporting (0.6): the terminal tells when its window gets or loses focus. Never text.
  const focus = focusEvent(input);
  if (focus !== undefined && !key.ctrl && !key.meta) {
    store.onFocus(focus);
    return;
  }
  if (key.ctrl && input === "c") {
    store.interrupt();
    return;
  }
  // The command palette (0.9): keys go to it while it is open.
  if (state.palette !== undefined && state.approval === undefined) {
    if (key.escape || (key.ctrl && input === "p")) store.closePalette();
    else if (key.upArrow) store.movePalette(-1);
    else if (key.downArrow) store.movePalette(1);
    else if (key.return) store.pickPalette();
    else if (key.backspace || key.delete) store.paletteQuery(null);
    else if (input !== "" && !key.ctrl && !key.meta && !/[\r\n\t]/.test(input))
      store.paletteQuery(input);
    return;
  }
  if (state.approval !== undefined) {
    if (key.upArrow) store.moveApproval(-1);
    else if (key.downArrow) store.moveApproval(1);
    else if (key.return) store.choose();
    else if (/^[1-9]$/.test(input)) {
      const picked = state.approval.choices[Number(input) - 1];
      if (picked !== undefined) store.choose(picked.choice);
    } else if (input === "y") store.choose("once");
    else if (input === "a") store.choose("session");
    else if (input === "n" || key.escape) store.choose("deny");
    return;
  }
  if (key.ctrl) {
    const actions: Record<string, () => void> = {
      o: () => store.showLastOutput(),
      p: () => store.togglePalette(),
      g: () => store.openEditor(),
      a: () => store.editLine({ type: "home" }),
      e: () => store.editLine({ type: "end" }),
      u: () => store.editLine({ type: "killToStart" }),
      k: () => store.editLine({ type: "killToEnd" }),
      w: () => store.editLine({ type: "deleteWord" }),
      d: () =>
        state.editor.text === "" && !state.busy ? store.exit() : store.editLine({ type: "delete" }),
    };
    actions[input]?.();
    return;
  }
  if (key.return) {
    // A new line instead of sending: Alt+Enter, or "\" at the end of the text before the cursor.
    const before = state.editor.text.slice(0, state.editor.cursor);
    if (key.meta) store.editLine({ type: "insert", text: "\n" });
    else if (before.endsWith("\\")) {
      store.editLine({ type: "backspace" });
      store.editLine({ type: "insert", text: "\n" });
    } else store.submitLine();
  } else if (key.escape) {
    // Esc stops a running turn (and drops queued lines); it never exits Garuda.
    if (state.busy) store.stopTurn();
    else store.clearQueue();
  }
  // Many terminals send Backspace as DEL, which Ink reports as `delete`.
  else if (key.backspace || key.delete) store.editLine({ type: "backspace" });
  else if (key.leftArrow) store.editLine({ type: key.meta ? "wordLeft" : "left" });
  else if (key.rightArrow) store.editLine({ type: key.meta ? "wordRight" : "right" });
  else if (key.upArrow) store.editLine({ type: "up" });
  else if (key.downArrow) store.editLine({ type: "down" });
  else if (key.tab) {
    // Shift+Tab switches between build and plan mode (0.4); Tab completes (0.6).
    if (key.shift) store.toggleMode();
    else store.completeLine();
  } else if (/[\r\n]/.test(input)) typeAhead(store, input);
  else if (input !== "" && !key.meta) store.editLine({ type: "insert", text: input });
}

/**
 * Keys typed before Ink was ready, or faster than it reads, arrive as one chunk,
 * for example "run the tests\n" (the terminal turns Enter into \n before raw mode).
 * Each line end is an Enter. Pastes do not come here: they come through usePaste.
 */
export function typeAhead(store: ChatStore, chunk: string): void {
  const parts = chunk.split(/\r\n|\r|\n/);
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    // Keys that arrive together ("\" and Enter typed fast): the backslash still means a new line.
    if (!last && part.endsWith("\\")) {
      store.editLine({ type: "insert", text: `${part.slice(0, -1)}\n` });
      return;
    }
    if (part !== "") store.editLine({ type: "insert", text: part });
    if (!last) store.submitLine();
  });
}
