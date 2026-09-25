# Subagents (`src/agents/`)

## Purpose

Keep the main agent's context small on open questions. The main agent calls the `explore` tool with a
question; a child agent searches the code with read-only tools in its own context and returns a short
answer with `path:line` references. The main context gets the answer, not every file that the child
read. Added in 0.3.

Subagents are split by task, not by language: the language profiles ([languages.md](languages.md)) give
language knowledge to every agent.

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
- A deny rule `explore` in the settings turns the tool off for one project; `subagents.enabled: false`
  removes it (and its prompt lines).
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

`garuda eval --subagents on|off` (default on) and `--subagent-model <spec>` make A/B runs possible;
`report.json` records both.

## Tests

`test/explore.test.ts`: a full turn with a separate child model (only read-only tools; unknown and
sensitive calls fail; the answer and trailer reach the main agent; progress events; usage and cost in
the session, the run and after resume; the child file and the report in the parent record); the main
model as default with a wrap-up after the step limit; `subagents.enabled: false` and a deny rule; input
validation; the chat's live line and summaries; settings.
