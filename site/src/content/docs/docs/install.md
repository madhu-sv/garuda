---
title: Install
description: Build Garuda from source on macOS or Linux.
---

Garuda is not on npm yet. Clone it and build it.

## Requirements

- macOS or Linux.
- Node 22 or later, pnpm 10 and git.
- For the OS sandbox on Linux: bubblewrap (`bwrap`). On macOS the sandbox is built in.

Node 25 and later do not include corepack, so install pnpm with npm:

```sh
npm install -g pnpm@10
```

## Build

```sh
git clone https://github.com/madhu-sv/garuda.git ~/garuda
cd ~/garuda
pnpm install
pnpm check   # optional: typecheck, lint and tests
pnpm build
```

## Put `garuda` on your PATH (optional)

```sh
pnpm setup          # once: makes a folder for global commands
pnpm link --global  # in ~/garuda
garuda --version
```

Without this step, start Garuda with `node ~/garuda/dist/cli/index.js`.

## The sandbox on Linux

Install bubblewrap with your package manager, for example `sudo apt install bubblewrap`. Some
systems block the user namespaces that bubblewrap needs. At startup Garuda checks that the sandbox
works. If it does not, Garuda says why and runs commands on the host, where every command asks
first. See [Sandbox](/garuda/docs/guide/#sandbox) in the user guide.

## A standalone binary

With Node 25.5 or later, `pnpm package` builds one file, `bin/garuda`, that holds Node and Garuda.
The target machine then does not need Node. See the
[user guide](/garuda/docs/guide/#standalone-binary).
