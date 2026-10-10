---
title: Security model
description: How Garuda keeps a model's actions inside your rules.
---

A coding agent runs commands and edits files for a model. A prompt injection in a file, a web page
or a tool result can try to make the model do harm. Garuda puts each action through checks that the
model cannot turn off. This page gives the overview; the
[architecture](/garuda/docs/design/architecture/) has the full threat table.

## The permission engine

Every tool call goes through one check before it runs:

1. **The team policy** (if one exists) can deny a command, a path or a host. Nothing overrides it.
2. **Sensitive files** (`.env*`, keys, cloud credentials) are blocked, also for reads and also
   through a symbolic link.
3. **Protected paths:** write tools never change `.git/`.
4. **Deny rules** always win over allow rules.
5. **Read-only tools** run with no question. **Commands in the OS sandbox** run with no question.
6. **Allow rules and earlier answers** for this session let a call run.
7. **Otherwise Garuda asks you**, and shows the diff or the command. A command outside the sandbox
   always asks, and the question says so.

## The OS sandbox

Seatbelt on macOS and bubblewrap on Linux. A command in the sandbox:

- reads every file except the secrets in your home folder (`~/.ssh`, `~/.aws`, keychains, tokens);
- writes only in the project, the temp folders and the package caches;
- cannot write `.git/hooks`, `.git/config` or `.garuda/`, because they run or apply later outside
  the sandbox;
- has no network, unless you open an allowlist;
- cannot start apps on macOS, and sees only its own processes on Linux;
- gets only a short list of environment variables, so API keys stay out.

## The network allowlist

When you list hosts (or presets such as `npm` and `pypi`), sandboxed commands reach them through
Garuda's own proxy. Another host asks first. IP addresses, private addresses and ports other than
80 and 443 are refused.

## The team policy

A managed file and `~/.garuda/policy.json` set the rules for a machine or a team: denied commands,
denied paths, a required sandbox, blocked hosts, allowed models and step and token limits. A project
cannot change them, and they hold for subagents and hooks too.

The strict profile (`"profile": "strict"` in a policy file or in `.garuda/settings.json`) requires
the OS sandbox. Without one, Garuda stops at startup and does not run commands on your machine. The
`bash` tool then has no `outside_sandbox` option. A project can turn the strict profile on, but not
off.

## Consent for project content

A cloned repository can carry hooks, MCP servers, slash commands, skills, agents and settings. Each
one that can run code or loosen safety asks once and shows its full content. The answer is pinned
to a hash in `~/.garuda/trust.json`, so a change asks again.

## The audit log

Every permission decision, tool run and hook command goes to `~/.garuda/audit/`, outside the
project. Secrets are redacted. Each line is chained to the one before by a hash, and `/audit verify`
finds a changed, removed or inserted line. The log is tamper-evident, not tamper-proof: someone who
can write the file can rewrite the whole chain, and lines cut from the end are not detected.

## Known limits

The open limits of each release are listed in the
[README](https://github.com/madhu-sv/garuda#status). To report a problem, see
[SECURITY.md](https://github.com/madhu-sv/garuda/blob/main/SECURITY.md).
