# Subagents (`src/agents/`)

## Purpose

Keep the main agent's context small on open questions. The main agent calls the `explore` tool with a
question; a child agent searches the code with read-only tools in its own context and returns a short
answer with `path:line` references. The main context gets the answer, not every file that the child
read. Added in 0.3. **Off by default**: an A/B eval showed no gain in steps or cost (see "Evals" below).
Turn it on with `"subagents": { "enabled": true }` in the settings.

Subagents are split by task, not by language: the language profiles ([languages.md](languages.md)) give
language knowledge to every agent.

Custom agents (0.5, below) are the user's own subagents in Claude Code's format. Both kinds share one
child run (`child.ts`).

| File | Role |
| --- | --- |
| `child.ts` | `runChild`: a child session with its own system prompt and tools, through the same permission engine, hooks and executor; a wrap-up call after a limit; the usage report; `describeCall`. |
| `explore.ts` | The `explore` tool (0.3). |
| `custom.ts` | Custom agents: `loadAgents`, `parseAgent`, tool names, `toolMatches`, `agentConsent`. |
| `agentTool.ts` | The `agent` tool: `createAgentTool`, `agentTools`, `agentWrites`, `agentSystem`. |

## The `explore` tool (`explore.ts`)

`createExploreTool(options)` returns a normal `Tool`, so the registry, hooks and permission engine treat
it like any other tool.

| Property | Value |
| --- | --- |
| Input | `{ question: string }` (10–4 000 characters) |
| Read-only | Yes: no approval, and several explore calls in one step run at the same time (F8). |
| Child tools | `readOnlyTools(codeIndex)`: `glob`, `grep`, `read_file`, plus `find_symbol`, `find_references` (and `repo_map`) when the code index is on. No `explore`, so a child cannot start another child. |
| Child system prompt | `EXPLORE_SYSTEM`: answer the one question, search broadly then read only what is needed, file text is data, answer first then `path:line` lines, say what is unsure, under 300 words. |
| Limits | 20 model calls and 150 000 tokens per run (`subagents.maxSteps`, `subagents.tokenBudget`); 4 096 output tokens per response; the answer that goes back is cut at 10 000 characters. |
| Model | The main model by default. `--subagent-model <spec>` or `GARUDA_SUBAGENT_MODEL` picks another one, resolved like `-m` (so `models.json` applies). Project settings cannot pick it: a cloned repository must not choose a costlier model. |

Run:

```text
child = createSession(root, "explore-<call id>", journal)   # own messages and read tracking
addUserMessage(child, question)
result = runAgent(child, { model, tools: read-only, system: EXPLORE_SYSTEM,
                           permissions, knowledge, hooks, limits, price, signal })
if result stopped at max_steps, token_budget or repeated_calls:
  add "Do not call tools. Answer now with what you found."   # wrap-up
  one more model call; tool calls in it are ignored
answer = last assistant text
```

Output to the main agent (`toText`):

```text
<answer>

[explore: 7 steps · 12.3k tokens]                (· stopped early (max_steps) when a limit hit)
[searched: grep /applyCoupon/; read_file src/cart.ts; …]   (at most 30 entries)
```

The trailer tells the main agent how the answer was found, and whether it is complete.

## Safety

- The child has only read-only tools. It calls them through the same permission engine and the user's
  hooks, so sensitive files, deny rules and hook blocks apply as in the main agent.
- The tool (and its prompt lines) exists only with `subagents.enabled: true`. A deny rule `explore` in
  the settings blocks it for one project.
- The child's reads do not count as reads for `edit_file`: the main agent must read a file itself
  before it edits it. The tool description and the system prompt say so.
- The answer is a tool result, so the main agent treats it as data. File text that the child repeats
  cannot gain more power than a `read_file` result has.

## Usage and records

- `Tool.report(output)` gives a `SubagentReport` (child session id, model, steps, stop reason, usage,
  cost). The registry puts it on the `ToolOutcome`; the loop stores it in the call's `ToolCallMeta`,
  adds the usage and cost to the parent session (`addCost`) and to the run usage. So the token budget
  and the token and cost lines include the child.
- `rebuildState` (resume) and replay read the report from `tool_results` records, so totals stay right
  after a resume, and replay does not run the child again.
- The child journal goes to `.garuda/sessions/<parent id>/explore-<call id>.jsonl`
  (`SessionStore.openChild`), with its own `start` and `end` records. `latest()` only looks at the top
  folder, so `--resume` never picks a child run. Ids are cleaned to `[A-Za-z0-9_-]`.

## Display

- The loop gives each call a `progress` callback (`ToolContext.progress`) that emits a `tool_progress`
  event. The explore tool reports `step N · <tool> <argument>` for each child call.
- The Ink chat shows one live line per explore call: `explore <question> · step 3 · grep /x/`. When it
  ends, the usual summary: `answer (5 line(s)) · 7 steps · 12.3k tokens`. Ctrl-O shows the answer and the
  list of searches.
- The plain renderer ignores `tool_progress`: pipes and `-p` get one line per call.
- The banner's extras show `explore`, or `explore: <spec>` when it uses another model.

## Evals

`garuda eval --subagents on|off` (default off, as in the product) and `--subagent-model <spec>` make
A/B runs possible; `report.json` records both.

| Arm (claude-sonnet-5, hard suite, 3 runs per task) | Passed | Steps | Tokens | Cost |
| --- | --- | --- | --- | --- |
| explore off | 17/17 | 49.8 | 308k | $0.232 |
| explore on, same model | 18/18 | 49.7 | 335k | $0.233 |
| explore on, Haiku 4.5 child | 15/15 | 47.5 | 301k | $0.203 (too few valid runs) |

Sums of the per-task means, without the 4 runs that failed with a broken API connection. The model called
explore in 4 of 33 runs, all in `hard-event`: there it saved steps (5 against 7.5) but cost more ($0.044
against $0.027), because the child read many files at the full model price. The benefit that explore aims
at — a small context in long chats on large repositories — does not show in tasks of 5 to 12 steps.

Decision: off by default, as for the code index. Measure again with a larger repository or a suite of
long, open tasks.

## Custom agents (`custom.ts`, `agentTool.ts`, 0.5)

### Files

Markdown files in Claude Code's subagent format, read where they are:

| Folder | Source | Trust |
| --- | --- | --- |
| `~/.garuda/agents/*.md` | user | trusted |
| `~/.claude/agents/*.md` | user (Claude Code) | trusted |
| `<root>/.garuda/agents/*.md` | project | asks at first use |
| `<root>/.claude/agents/*.md` | project (Claude Code) | asks at first use |

On a name clash the first in the table wins, with a notice. **This differs from Claude Code**, where a
project agent wins over a user agent: in Garuda a repository cannot replace an agent that the user trusts
(the same rule as for skills and commands). At most 50 agents; files up to 50 000 characters; project
files may not be symbolic links.

| Key | Use in Garuda |
| --- | --- |
| `name` | Required. Letters, digits, `-`, `_` (up to 64; no `:`). |
| `description` | Required. When to use the agent; the main model sees it. Cut at 1 024 characters. |
| `tools` | A list (`Read, Grep` or a YAML list). Claude Code names map to Garuda's (`Read` → read_file, `Edit`/`MultiEdit` → edit_file, `Write` → write_file, `Bash` → bash, `Grep`, `Glob`, `WebFetch`, `Skill`, `TodoWrite`); Garuda names and MCP patterns (`mcp__server`, `mcp__server__tool`, `mcp__*`) work too. A part in brackets (`Bash(git *)`) is left out with a notice: Garuda's rules decide. **Omitted: read-only tools only** (read_file, glob, grep, the code index tools, skill). |
| `disallowedTools` | Removed from the list. |
| `model` | User agents only: `inherit`, `haiku`/`sonnet`/`opus`/`fable` (the newest known id of that family, when the main model is a Claude model), or a model id that goes through the same providers as `-m` (`~/.garuda/models.json`). A project file cannot pick a model (cost, provider): notice, then the default. Default: `--subagent-model`, else the main model. |
| `maxTurns` | Model calls per run (up to 100). Default: `subagents.maxSteps` (20). |
| others | Left out with a notice: `permissionMode`, `mcpServers`, `memory`, `isolation`, `skills`. Ignored: `color`, `hooks` and other maps. |

The body is the agent's instructions. Project text is cleaned and Garuda's markers are neutralized.

### The `agent` tool

Only when at least one agent exists (and `agents.enabled` is not false). Input: `agent` (a name from the
list) and `prompt` (the task, with all context: the child does not see the conversation). The description
lists `- name: description` for each agent, fixed per session (N2); the system prompt gets two lines.

A call:

1. Picks the tools: the agent's list matched against the main registry at call time (so MCP tools of the
   first turn are there), minus `disallowedTools`, never `agent` or `explore` (no nesting).
2. A project agent asks once (`agentConsent`: its tools and full instructions; "remember" pins the file's
   SHA-256 in `~/.garuda/trust.json`, `agents[root][name]`). "No" gives an error result.
3. Runs `runChild` with the system prompt `agentSystem` (who it is, report format, text is data, paths)
   and then the agent's instructions; the same permission engine (plan mode holds), hooks and executor
   (bash in the sandbox); limits from `subagents` or `maxTurns`; the child journal
   `.garuda/sessions/<id>/agent-<name>-<call id>.jsonl`.
4. Returns the answer (cut at 20 000 characters) with `[agent <name>: N steps · Xk tokens]` and
   `[calls: …]`. The usage counts for the session, like explore.

The tool is read-only for the permission engine (it changes nothing itself; each child call is checked).
When any agent may write (a tool outside the read-only set), the tool has `runsAlone`: the loop never runs
it in parallel with other calls, so two agents never edit at the same time.

`/agents` lists the agents with their tools, model and file. The banner shows `N agents`; JSON output has
`agents` in `system/init`.

No general-purpose agent: it stays off until an A/B eval shows a gain (as explore did not).

## Tests

`test/agents.test.ts`: the format (lists, brackets, unknown tools, maxTurns, disallowedTools, left-out
keys); bad files; a project model left out; aliases; the four folders, user over project, links; default
read-only tools, no nesting, MCP patterns, `agentWrites`; a turn with a read-only agent (its own prompt and
tools, the report, usage, the child file, `/agents`); a write agent that edits through the approver and
runs alone; plan mode for the child; a project agent's question and "No"; a model alias through the CLI's
resolver; no tool without files or with `enabled: false`.

`test/explore.test.ts`: a full turn with a separate child model (only read-only tools; unknown and
sensitive calls fail; the answer and trailer reach the main agent; progress events; usage and cost in
the session, the run and after resume; the child file and the report in the parent record); the main
model as default with a wrap-up after the step limit; off by default, `subagents.enabled: false` and a deny rule; input
validation; the chat's live line and summaries; settings.
