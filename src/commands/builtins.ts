/**
 * The names of the chat's built-in commands (src/cli/chat/commands.ts). A custom command cannot
 * use them. A test checks that this list and the chat's commands agree.
 */
export const BUILTIN_COMMANDS: readonly string[] = [
  "help",
  "usage",
  "session",
  "sessions",
  "models",
  "export",
  "compact",
  "diff",
  "schedule",
  "jobs",
  "where",
  "refs",
  "map",
  "mcp",
  "hooks",
  "lsp",
  "commands",
  "agents",
  "plan",
  "build",
  "new",
  "init",
  "editor",
  "details",
  "undo",
  "redo",
  "exit",
  "quit",
];
