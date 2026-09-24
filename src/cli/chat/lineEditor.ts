/**
 * The chat input line: text, cursor and history. Pure state, so tests need no terminal.
 * The Ink view maps keys to these actions.
 */
export interface EditorState {
  text: string;
  /** Cursor position in `text` (0 … text.length). */
  cursor: number;
  /** Earlier inputs, newest first. */
  history: string[];
  /** -1 when not browsing history. */
  historyIndex: number;
  /** The text typed before history browsing started. */
  draft: string;
}

export const emptyEditor = (history: string[] = []): EditorState => ({
  text: "",
  cursor: 0,
  history,
  historyIndex: -1,
  draft: "",
});

export type EditAction =
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "wordLeft" }
  | { type: "wordRight" }
  | { type: "deleteWord" }
  | { type: "killToStart" }
  | { type: "killToEnd" }
  | { type: "up" }
  | { type: "down" }
  | { type: "clear" };

export function edit(state: EditorState, action: EditAction): EditorState {
  const { text, cursor } = state;
  const set = (next: string, at: number): EditorState => ({
    ...state,
    text: next,
    cursor: Math.max(0, Math.min(at, next.length)),
    historyIndex: -1,
  });
  switch (action.type) {
    case "insert": {
      // A paste can bring \r\n or \r: keep them as new lines.
      const add = action.text.replace(/\r\n?/g, "\n");
      return set(text.slice(0, cursor) + add + text.slice(cursor), cursor + add.length);
    }
    case "backspace":
      return cursor === 0 ? state : set(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
    case "delete":
      return cursor === text.length
        ? state
        : set(text.slice(0, cursor) + text.slice(cursor + 1), cursor);
    case "left":
      return { ...state, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { ...state, cursor: Math.min(text.length, cursor + 1) };
    case "home":
      return { ...state, cursor: 0 };
    case "end":
      return { ...state, cursor: text.length };
    case "wordLeft":
      return { ...state, cursor: wordStart(text, cursor) };
    case "wordRight":
      return { ...state, cursor: wordEnd(text, cursor) };
    case "deleteWord": {
      const start = wordStart(text, cursor);
      return set(text.slice(0, start) + text.slice(cursor), start);
    }
    case "killToStart":
      return set(text.slice(cursor), 0);
    case "killToEnd":
      return set(text.slice(0, cursor), cursor);
    case "clear":
      return { ...emptyEditor(state.history) };
    case "up": {
      if (state.historyIndex + 1 >= state.history.length) return state;
      const index = state.historyIndex + 1;
      const entry = state.history[index] ?? "";
      return {
        ...state,
        text: entry,
        cursor: entry.length,
        historyIndex: index,
        draft: state.historyIndex === -1 ? text : state.draft,
      };
    }
    case "down": {
      if (state.historyIndex === -1) return state;
      const index = state.historyIndex - 1;
      const entry = index === -1 ? state.draft : (state.history[index] ?? "");
      return { ...state, text: entry, cursor: entry.length, historyIndex: index };
    }
  }
}

/** Take the text out for submit. The text goes to history; the line is empty again. */
export function submit(state: EditorState): { text: string; state: EditorState } {
  const text = state.text;
  const history =
    text.trim() === "" || state.history[0] === text ? state.history : [text, ...state.history];
  return { text, state: emptyEditor(history.slice(0, 200)) };
}

function wordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i--;
  return i;
}

function wordEnd(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  while (i < text.length && !/\s/.test(text[i] ?? "")) i++;
  return i;
}
