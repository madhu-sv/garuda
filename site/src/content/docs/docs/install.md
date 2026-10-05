---
title: Install
description: Install Garuda with Homebrew or npm, or build it from source, on macOS or Linux.
---

Garuda runs on macOS and Linux with Node 22 or later. Versions 0.14.1 and later are on Homebrew
and npm.

## Homebrew

```sh
brew install madhu-sv/garuda/garuda
garuda --version
```

The formula is in the tap [madhu-sv/homebrew-garuda](https://github.com/madhu-sv/homebrew-garuda).
Homebrew installs Node if you do not have it.

## npm

```sh
npm install -g @garuda-agent/garuda
garuda --version
```

The package is published from the repository's release workflow with npm trusted publishing, so
`npm audit signatures` can check its provenance.

## Build from source

You need Node 22 or later, pnpm 10 and git. Node 25 and later do not include corepack, so install
pnpm with npm:

```sh
npm install -g pnpm@10
git clone https://github.com/madhu-sv/garuda.git ~/garuda
cd ~/garuda
pnpm install
pnpm check   # optional: typecheck, lint and tests
pnpm build
```

To put `garuda` on your PATH:

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
