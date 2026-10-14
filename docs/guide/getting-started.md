# Install and first run

Install Garuda, store a model and key, run the chat or one task, JSON output for scripts.

## Use

Install (0.14.1 and later) with Homebrew or npm. You need Node 22 or later; Homebrew installs it.

```sh
npm install -g @garuda-agent/garuda
```

Or with Homebrew (macOS and Linux). Homebrew loads a formula from a third-party tap only after you
trust it, so trust the Garuda formula first:

```sh
brew tap madhu-sv/garuda
brew trust --formula madhu-sv/garuda/garuda
brew install garuda
```

Or build from source. You need Node 22 or later, pnpm 10 and git. Node 25 and later do not include
corepack, so install pnpm with npm.

```sh
npm install -g pnpm@10
git clone https://github.com/madhu-sv/garuda.git && cd garuda
pnpm install
pnpm check          # typecheck + lint + tests
pnpm build
pnpm link --global  # optional: puts `garuda` on your PATH (run `pnpm setup` once first)
```

Then:

```sh
garuda setup                            # once: pick a provider and model, enter the key
garuda                                  # chat in the current folder
garuda -p "Explain what this repo does" # run one task and exit
echo "Explain this repo" | garuda       # the same, from stdin
```

From a source build without `pnpm link`, use `node dist/cli/index.js` in place of `garuda`.

`garuda setup` (0.16) asks for the provider, the model and the key (hidden input), checks the key
with one free request to the provider, and stores the model as `"default"` in
`~/.garuda/models.json` and the key in `~/.garuda/credentials` (mode 0600; commands in the sandbox
cannot read it). `garuda setup --show` shows the model and where each key comes from (masked);
`garuda setup --forget [NAME]` removes stored keys. With a Claude key, setup lists the models of
your account (a free request) and saves the list for `/models`; prices come from Garuda's own table. Environment variables still work and win:
`ANTHROPIC_API_KEY`, `GARUDA_MODEL`. Do not sync or back up `~/.garuda/credentials` to other places.

Tools: read_file, glob and grep run with no question.
write_file and edit_file show a diff first. You pick: allow once, allow for this session, or deny.
Commands (bash) run in an OS sandbox when your machine has one (see [Sandbox](safety.md#sandbox)). There they run
with no question: the sandbox lets them write only in the project, temp folders and package caches,
with no network. So a command can change project files without a question; `/undo` restores the
files in its snapshot (ignored files, such as build output, are not in it). A command outside the
sandbox asks, unless one of your allow rules covers it; the strict profile forbids it. Without a
sandbox, each command asks first, unless one of your allow rules covers it, so read each one before
you allow it.
Garuda removes a leading `cd <working root> &&` from a command, because each command already starts there.
When the model reads files with bash, or pipes into head or tail, the result adds a short `[Garuda: …]` note that tells it to use the file tools.

For scripts and CI, `--output-format json` prints one JSON result, and `--output-format stream-json`
prints one JSON object per line as the task runs. The fields are those of Claude Code's headless mode
(`claude -p --output-format …`), so the same scripts work:

```sh
g -p "Run the tests" --output-format json | jq -r '.subtype, .total_cost_usd, .result'
g -p "Fix the lint errors" --output-format stream-json --verbose > run.jsonl
```

`total_cost_usd` is always a number. Check `total_cost_is_unknown` (no price) and
`total_cost_is_incomplete` (a known minimum, for example after a failed attempt) before you use it
as an exact cost.

stdout holds only JSON; warnings and errors go to stderr (`--verbose` adds the tool activity). The exit
code does not change. Details: [docs/lld/cli.md](../lld/cli.md#json-output-jsonoutputts-05).

Try it on this repo:

```sh
node dist/cli/index.js -p "Where is runAgent defined, and what does it do?"
node dist/cli/index.js -p "Run the tests and tell me the result"
```

## Standalone binary

`pnpm package` builds one executable file, `bin/garuda`, for the machine you build on.
It holds Node and all of Garuda, so the target machine does not need Node.
It needs Node 25.5 or later to build (it uses `node --build-sea`).

```sh
pnpm package
./bin/garuda                 # greeting
./bin/garuda --version
sudo cp bin/garuda /usr/local/bin/   # optional: put it on your PATH
```

Notes:

- The binary is about 100–150 MB, because it contains the Node runtime.
- Build on each platform that you want to run on. A binary built on an Apple silicon Mac runs only on Apple silicon Macs.
- On macOS, the script signs the binary ad hoc (`codesign --sign -`), so it runs on the machine that built it.
- Homebrew's Node has single executables turned off. The script then downloads the official Node build of
  the same version from nodejs.org, checks its SHA-256 sum and keeps it in `~/.cache/garuda`.
  Set `GARUDA_SEA_NODE=/path/to/node` to use a Node binary of your choice, or `NODEJS_ORG_MIRROR` to use a mirror.
