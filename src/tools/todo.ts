import { z } from "zod";
import type { Tool } from "./types.js";

/**
 * todo_write (0.4): the model keeps a short plan for a task with several steps. Each call sends
 * the whole list; the result shows it back. The list lives in the conversation, so it needs no
 * state here, and resume and compaction keep it like any other tool result.
 *
 * It changes no file and runs nothing, so it needs no approval (read-only in the permission
 * sense). Off by default until an A/B eval shows that it helps (settings: "todo").
 */

export const TODO_TOOL = "todo_write";
export const TODO_MAX_ITEMS = 30;

const STATUS = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof STATUS)[number];

const inputSchema = z.strictObject({
  todos: z
    .array(
      z.strictObject({
        content: z.string().trim().min(1).max(300).describe("One step, in a few words."),
        status: z.enum(STATUS),
      }),
    )
    .max(TODO_MAX_ITEMS)
    .describe("The whole list, in order. Each call replaces the list."),
});

export type TodoInput = z.infer<typeof inputSchema>;
export type TodoItem = TodoInput["todos"][number];

/** The marks in the text that the model sees; the chat draws its own symbols. */
export const TODO_MARKS: Readonly<Record<TodoStatus, string>> = {
  completed: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
};

export const todoWriteTool: Tool<TodoInput, TodoItem[]> = {
  name: TODO_TOOL,
  description:
    "Keep a todo list for a task with 3 or more steps. Send the whole list each time. Mark exactly one step in_progress while you work on it, and mark each step completed as soon as it is done. Do not use it for a simple task.",
  inputSchema,
  readOnly: true,
  async run({ todos }) {
    const active = todos.filter((t) => t.status === "in_progress").length;
    if (active > 1) {
      throw new Error(`${active} steps are in_progress. Mark only one step in_progress at a time.`);
    }
    return todos;
  },
  toText(todos) {
    if (todos.length === 0) return "The todo list is empty.";
    const done = todos.filter((t) => t.status === "completed").length;
    return [
      `Todo list (${done} of ${todos.length} done):`,
      ...todos.map((t) => `${TODO_MARKS[t.status]} ${t.content}`),
    ].join("\n");
  },
};
