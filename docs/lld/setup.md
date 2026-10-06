# Setup and stored keys (`garuda setup`, 0.16, planned)

Status: released in 0.16.0 (patches 0167–0172): reading the credentials file, the sandbox rule and
the default model (0168), `garuda setup` (0169), Terminal Auth in `garuda acp` (0170), docs and the
live test in Zed (0171). Planned: the ACP Registry and VS Code pull requests. The plan is at the end.

## Purpose

A new user, or an editor that installed Garuda from the ACP Registry, has no model and no API key:
today both come only from `--model` / `GARUDA_MODEL` and from environment variables. An editor
started from the Dock or the Start menu does not read the shell profile, and an agent installed
from the registry gets no environment from the user at all.

`garuda setup` asks once, in a terminal, for the provider, the model and the provider's key, and
keeps them for later starts. `garuda acp` offers it to the editor as ACP **Terminal Auth**, which the
ACP Registry requires (it lists only agents with Agent Auth or Terminal Auth). Zed and JetBrains
IDEs install agents from that registry with one click.

## Decisions

| Question | Decision | Reason |
| --- | --- | --- |
| Where does the key go? | `~/.garuda/credentials`, mode 0600, written only by `garuda setup`. | Works on macOS and on every Linux (also servers, containers, WSL and remote development, where no keyring service runs). The OS sandbox already has a tested way to hide a home file from commands; the same pattern hides this one. `gh`, the AWS CLI and npm store their tokens the same way. |
| Why not the OS keychain (first)? | Later, and only with sandbox blocks. | A sandboxed command runs as the same user and could read the key back: on macOS with `security find-generic-password -w` (no prompt for items that `security` stored), on Linux with `secret-tool` over the D-Bus socket in `/run/user/<uid>`. Blocking that needs new Seatbelt and bubblewrap rules and their tests. |
| Which wins? | `--model` > `GARUDA_MODEL` > the stored default model. An environment variable > the stored key. | A user or a script that sets a value means it; the stored values are the fallback. |
| Windows? | Not supported (as today). `garuda acp` ends `session/new` on native Windows with a clear message; WSL works as Linux. | The sandbox is Seatbelt or bubblewrap and the bash tool needs a POSIX shell. Windows support (a Windows sandbox, a shell, Credential Manager) is a future step. |

N6 ("No secrets on disk") gets one stated exception: the credentials file that the user asked
`garuda setup` to write. Session files, the audit log and trust files still hold no secret.

## Files

| File | Owner | Content |
| --- | --- | --- |
| `~/.garuda/credentials` | Garuda (`garuda setup`) | JSON: key name → key, for example `{ "ANTHROPIC_API_KEY": "sk-ant-…" }`. Mode 0600, in `~/.garuda` (0700). Written atomically. |
| `~/.garuda/models.json` | User | Gets one new optional field, `"default": "<model spec>"`, written by `garuda setup` (the rest of the file is kept as it is). |

The key name is the provider's `apiKeyEnv` (`ANTHROPIC_API_KEY` for Claude, `OPENROUTER_API_KEY`,
or a custom provider's own name), so one name means the same key in the environment and in the
file.

## Reading the key

At startup (the chat, `-p`, jobs, evals, `garuda acp`), after the models and search config are
loaded:

1. For each key name that Garuda needs, an environment variable wins (as today).
2. Otherwise Garuda reads `~/.garuda/credentials`:
   - Only a regular file, owned by the user, with no group or other permission bits. Else the file
     is ignored with a warning that says how to fix it (`chmod 600 ~/.garuda/credentials`), as SSH
     does.
   - Not a symbolic link (`lstat`): a link could point somewhere a project controls.
   - Invalid JSON: ignored with a warning; Garuda never prints the file.
3. The key goes into the same in-process store as `keepProviderKey` (0.14): it never enters
   `process.env`, so no command and no `/proc/<pid>/environ` can see it, and the redactor knows it
   (`keepSecretForRedaction`), so a session file cannot hold it.

Built as `readCredentials` (`src/model/credentials.ts`) and `keepProviderKeys` (`providers.ts`).
Garuda keeps every stored key, not only the current model's, so `/model` can switch to another
stored provider. The redactor knows each stored key whatever its name (a custom `apiKeyEnv` need not
look secret). The file is opened with `O_NOFOLLOW` and checked on the open file (`fstat`), so it
cannot change between the check and the read. A file larger than 64 KiB is ignored.

A project cannot add or change a stored key: only `garuda setup` writes the file, and only providers
from `~/.garuda/models.json` (never from the project) can name a key (0.14 rule, unchanged).

## The sandbox

`.garuda/credentials` joins `DENY_READ_IN_HOME` (next to `.garuda/mcp-auth.json`): a command in the
OS sandbox cannot read it, on macOS (Seatbelt) or Linux (bubblewrap). The file tools refuse it
already: it is outside the root, and `credentials` is in the sensitive patterns. On the host
executor (no sandbox), each command asks first, as today.

## `garuda setup`

An interactive command (inquirer, loaded with `import()` so other commands start as fast as
before):

1. **Provider**: Anthropic (Claude), OpenRouter, a local server (Ollama, LM Studio, llama.cpp, vLLM),
   or a provider from `~/.garuda/models.json`.
2. **Model**: a list of common models for the provider plus free text; for a local server, the
   models that its `/models` endpoint lists, when it answers.
3. **Key** (skipped for local servers): a hidden input. If the environment already has the key, setup
   says so and offers to keep using it (nothing stored).
4. **Check** (default yes): one free request that lists models (Anthropic `GET /v1/models`, an
   OpenAI-compatible `GET /models`), with the key, to the provider's own base URL. No model call,
   no cost. A failure says why (bad key, no network) and lets the user retry or store anyway.
5. **Store**: the default model in `models.json`, the key in `credentials`. The summary shows where
   each one went and the key masked (`sk-ant-…4f2c`).

Other forms:

- `garuda setup --show`: the current model and, per key name, where the key comes from
  (environment, file, missing), masked. Never the key.
- `garuda setup --forget [<key name>]`: removes a stored key (or all), after a question.
- With no terminal (stdin not a TTY), `garuda setup` stops with a message: it never reads a key from
  a pipe by mistake. A script sets the environment variable instead.

Exit code 0 means done (Terminal Auth needs this: "a zero exit status signals success"). A stop
after a failed check, or no terminal, gives 1; Ctrl-C gives 130. Nothing is written before the last
step.

Built as `src/cli/setupCommand.ts` (patch 3):

- Before any question, setup reads `~/.garuda/credentials`. When Garuda would ignore the file (a
  link, another owner, loose bits, invalid JSON), setup stops and says so: it never writes over such
  a file.
- The key file is written as a temporary file with mode 0600 from the start, then renamed into place
  (a rename replaces a link itself, never its target). Other stored keys stay. A new `~/.garuda` is
  0700; an existing one keeps its mode (the key file itself is 0600).
- `models.json` keeps its content; setup writes it again as JSON with two-space indents, with
  `"default"` set. A file that is not a JSON object stops setup.
- The check for Claude goes to `ANTHROPIC_BASE_URL` when it is set (the SDK's base URL, where the
  model calls go too), else `https://api.anthropic.com`. No redirects; 10 s at most.
- Keys and model names must be visible ASCII with no spaces. A local server's model list keeps only
  such names (at most 50).
- `maskKey`: at most the start (for example `sk-ant-`) and the last four characters; a key shorter
  than 32 characters shows only its last four, and one shorter than 16 shows nothing.
- `--show` needs no terminal; `--forget` asks, so it needs one. Removing the last key removes the
  file.

## ACP: Terminal Auth

- `initialize`: when the client's capabilities include `auth.terminal: true`, Garuda answers
  `authMethods: [{ "type": "terminal", "id": "garuda-setup", "name": "Set up Garuda", "description":
  "Choose a model and enter its API key.", "args": ["setup"] }]`. Without that capability, the list
  stays empty (the spec says an agent must not offer the method then).
- The editor runs its configured agent command with `args` added (the spec: "additional arguments
  to append to the configured agent invocation"). The configured command is `garuda acp` (or
  `npx @garuda-agent/garuda acp`), so the editor runs `garuda acp setup` in a terminal, and
  `garuda acp setup` runs `garuda setup`. The user answers there.
- `session/new` reads the setup again for each new session (0.15 read it once at start), so a
  session after the setup works with no restart. Each read replaces the stored keys of the last one,
  so a key that `--forget` removed is gone from the next session. With no model, or no key for the
  model's provider, `session/new` fails with the ACP error "auth required"
  (`RequestError.authRequired`) and the message, so the editor offers the setup.
- `authenticate`: a terminal method is never sent there (the spec forbids it); the method keeps
  answering `{}`.
- Native Windows: `session/new` fails with "Garuda supports macOS and Linux. On Windows, run Garuda
  in WSL (Windows Subsystem for Linux)." (not "auth required", so the editor does not loop on the
  setup). `initialize` offers no Terminal Auth there, and `garuda setup` stops with the same message:
  a key file needs Unix permissions (0600) to stay private.

Built in `src/acp/server.ts` (`terminalAuth`, `setupNeeded`, `SETUP_METHOD_ID`) and
`src/cli/acpCommand.ts` (`prepare` per session, `garuda acp setup`) (patch 4):

- "No key": the model's key name (`apiKeyEnv`, or `ANTHROPIC_API_KEY` for Claude) has no value in
  the environment or the file. For Claude, `ANTHROPIC_AUTH_TOKEN` also counts (the SDK's other way
  to sign in). A local server needs no key.
- The message says what is missing ("Garuda has no model." or "Garuda has no key for <model>
  (<NAME>).", with the warning when the file was ignored) and how to fix it.
- Other problems (an invalid `models.json`, an unknown provider, a broken team policy) stay a
  plain error: a setup would not fix them.
- `garuda acp <anything else>` stops with exit code 1.

## Security

| Risk | Answer |
| --- | --- |
| A sandboxed command reads the key file | `DENY_READ_IN_HOME`; a test on each OS reads it from the sandbox and fails. |
| A command reads the key from Garuda's environment | The key never enters `process.env` (in-process store, as since 0.14). |
| Another user on the machine reads the file | Mode 0600 in a 0700 folder; a looser file is ignored with a warning. |
| A project plants or swaps the file (a link, a looser file) | Only a regular file owned by the user; links ignored; projects cannot write `~/.garuda` from the sandbox. |
| The key ends up in a session file, a log or the audit log | The redactor knows the stored key; `--show` and the summary mask it. |
| A key goes to the wrong server | Providers and their base URLs only from `~/.garuda/models.json`; the check request goes to the provider's own base URL. Unchanged rule. |
| Backups or dotfile sync copy the file | Documented: exclude `~/.garuda/credentials`, or use environment variables. |
| A pipe or script answers the setup | No TTY, no setup. |

## Tests

All with a temporary home, never the user's:

- Key order: the environment wins over the file; the file fills a missing variable; nothing enters
  `process.env`; the redactor knows the key.
- The file is ignored (with its warning) when it is group- or world-readable, a symbolic link, not
  owned by the user, or invalid JSON.
- Sandbox: a command in the real OS sandbox cannot read `~/.garuda/credentials` (macOS and Linux),
  and can still read other `~/.garuda` files (skills).
- `garuda setup` with scripted answers: writes the default model and the key (0600, folder 0700),
  keeps the rest of `models.json`, masks the summary; `--show` never prints a key; `--forget` asks
  and removes; no TTY → message, nothing written; the check request goes to the provider's base URL
  (a local mock server).
- ACP: `authMethods` only with `auth.terminal`; `session/new` with no key → "auth required"; after a
  setup, the next `session/new` works with no restart; native Windows (a mocked platform) → the WSL
  message.
- Each rule gets a negative control: without it, its test fails.

Files: `test/credentials.test.ts`, `test/sandbox.test.ts` (patch 2), `test/setup.test.ts` (patch 3),
`test/acpAuth.test.ts` (patch 4).

## Plan

| Patch | Content |
| --- | --- |
| 1 | This design; the architecture (data stores, N6 exception, trust boundary, decision) and the HLD (`garuda setup`). |
| 2 (built) | The credentials file: reading, checks, the in-process store, `DENY_READ_IN_HOME`, the default model in `models.json`. Tests, including the sandbox on macOS and Linux. |
| 3 (built) | `garuda setup` (`--show`, `--forget`). Tests. |
| 4 (built) | ACP: Terminal Auth, "auth required", setup read per session, the Windows message. Tests. |
| 5 (built) | Docs (user guide, Editors page, README) and a live test in Zed: an agent entry with no `env`, the setup from the editor, then a chat. |
| 6 (0172) | Release 0.16.0. |
| 7 | The ACP Registry pull request (manifest per its CONTRIBUTING.md), and a pull request to VS Code's ACP Client agent list. |
