# Skills (`src/skills/`)

## Purpose

A skill is a folder of instructions for one kind of task, in the Agent Skills format
(<https://agentskills.io/specification>) that Claude Code uses (0.5). The model sees only each skill's
name and description. It loads the full instructions when a task matches, and reads the skill's other
files only when it needs them ("progressive disclosure"). The user can also run a skill with `/name`.

Garuda reads Claude Code's skill folders where they are, so no copy is needed.

## Files

| File | Role |
| --- | --- |
| `load.ts` | `loadSkills` (the four folders, precedence, problems), `parseSkill`, `parseSkillFrontmatter`, `expandSkill` (arguments), `skillConsent` (the question for a project skill). |
| `tool.ts` | `createSkillTool` (the `skill` tool), `skillText` (the loaded text, also for `/name`), `skillFolder`. |
| `frontmatter.ts` | `parseFrontmatterBlock`: the small frontmatter reader, shared with custom agents (plain, quoted and block values; lists become `a, b`; maps are skipped). |

## Where skills live

| Folder | Source | Trust |
| --- | --- | --- |
| `~/.garuda/skills/<name>/SKILL.md` | user | trusted |
| `~/.claude/skills/<name>/SKILL.md` | user (Claude Code) | trusted |
| `<root>/.garuda/skills/<name>/SKILL.md` | project | asks at first use |
| `<root>/.claude/skills/<name>/SKILL.md` | project (Claude Code) | asks at first use |

On a name clash the first folder in the table wins, with a notice: user skills win over project skills (as
in Claude Code), so a repository cannot replace a skill that the user trusts. A skill may not use the name
of a built-in chat command. At most 100 skills. A folder without `SKILL.md` is ignored with no notice.

## SKILL.md

| Key | Use in Garuda |
| --- | --- |
| `name` | The skill name: a–z, 0–9 and single hyphens, up to 64. Default: the folder name. |
| `description` | What it does and when to use it. Default: the first line of the body. With `when_to_use` appended; cut at 1 536 characters (as in Claude Code). |
| `when_to_use` | Appended to the description. |
| `argument-hint` | Shown by `/commands` and `/help`. |
| `disable-model-invocation` | `true`: only the user can run it (`/name`); not in the model's list. |
| `user-invocable` | `false`: only the model can load it; `/name` does not work. |
| others | Ignored: `allowed-tools` (every call still asks or runs in the sandbox), `model`, `context`, `hooks`, `paths`, `license`, `metadata` … |

The frontmatter reader handles `key: value`, quoted values and block values (`>` and `|`), and skips lists
and maps. SKILL.md may have up to 50 000 characters. Project text loses escape codes and invisible
characters (`cleanText`), and Garuda's own markers are neutralized (`<skill`, `<garuda_note`, `<mcp_result` …).

Arguments, as in Claude Code: `$ARGUMENTS` (all), `$ARGUMENTS[N]` and `$N` (one, from 0; quotes group
words), `${CLAUDE_SKILL_DIR}` or `${GARUDA_SKILL_DIR}` (the folder). `\$1` stays `$1`. With no placeholder,
`ARGUMENTS: <text>` goes after the body.

`!`command`` lines are not run: the text goes to the model as it is.

## The skill tool

The tool exists only when at least one skill may be loaded by the model. Its description has a short rule
and one line per skill (`- name: description`). The list is fixed when the session starts, so every request
sends the same tool bytes and the prompt cache stays valid (N2). The system prompt gets two lines about
skills in the same case.

Input: `name`, optional `arguments`, optional `file`. The tool is read-only (no approval, runs in parallel
with other reads; plan mode allows it).

- Without `file`: `<skill name="…" folder="…">` + the expanded body + `</skill>`, then the list of the
  folder's files (up to 50, three levels) and how to read or run them. The folder is relative to the root
  for project skills and absolute for user skills, so bash can run a script (the sandbox reads everywhere
  except secrets).
- With `file`: one file of the folder in `<skill_file>`, up to 100 000 characters. The path must stay inside
  the folder, also through symbolic links; binary files are refused.

`read_file` cannot read user skills (they are outside the root); `file` covers that.

## Trust

- A user skill loads with no question.
- A project skill asks the first time it loads (by the tool or by `/name`), with its full text. "Yes, for
  this session only" allows it for this process; "Yes, and remember" pins the SHA-256 of SKILL.md in
  `~/.garuda/trust.json` (`skills[root][name]`). A changed file asks again. "No" gives the model an error
  result: do the task without it.
- The model sees the name and description of a project skill before the question. They are short and cut;
  the question comes before any instructions reach the model.
- Questions wait for each other (`Runtime.allowSkill` chains them), because two skill calls can run at once.
- A skill is only text: the tool calls it leads to still ask, or run in the sandbox, as usual.

## Slash use

`Runtime.resolveCommand("/name args")` checks skills first: a skill wins over a custom command with the same
name (as in Claude Code). The prompt is `skillText`, the same text the tool gives. `/commands` and `/help`
list the skills with their folder and flags (`you only`, `model only`).

## On and off

- On when skills exist: with no skills, nothing changes (no tool, no prompt lines).
- `"skills": { "enabled": false }` in `.garuda/settings.json` turns them off.
- `Runtime.create` loads skills only with the `skills` option. The CLI passes it; tests and evals do not,
  so their results do not depend on the user's own skills.
- No A/B eval: the eval tasks have no skills. A skill's value depends on its text, not on Garuda.

## Other places

- `/init` no longer lists Claude Code skills as "not imported": Garuda reads them in place.
- JSON output: `system/init` has `skills` (names), and `slash_commands` includes user-invocable skills.
- The start banner shows `N skills`.

## Tests

`test/skills.test.ts`: the frontmatter reader (block values, lists and maps skipped); defaults from the folder
and the first line; argument expansion; the four folders, precedence, built-in names, size limit, project
links; the tool's list (model-invocable only), a load with files, `file` reads, escapes from the folder
(`..`, a link to `~/.ssh`, an absolute path); a project skill: the question, a relative folder, neutralized
markers, a "No"; the runtime: a model turn that loads a project and a user skill, the system prompt line,
the pinned hash, a changed file that asks again; `/name` with arguments, a skill over a command, the two
flags; no tool without skills, with `enabled: false`, or without the option.
