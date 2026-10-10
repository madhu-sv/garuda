---
title: "Garuda reviewed its own code before release"
description: "Seven review runs in plan mode, about $30 of model time, and one high-severity bug. What worked, what did not, and what I would do again."
date: 2026-10-03
author: Madhusudhan Vasanth Kumar
---

Garuda is a terminal coding agent. Its main promise is safety: commands run in an OS sandbox,
edits ask first, a team policy sets limits that a project cannot loosen, and an audit log records
every decision. Before I released 0.14.0, I wanted to test that promise on the code that makes it.
So I asked Garuda to review its own code.

## The setup

A review must not change the thing it reviews. Garuda has a plan mode for this: the agent can read
files and run commands in a sandbox that cannot write the project, and it ends with a plan instead
of edits. That made plan mode a safe harness for a code review.

I wrote a small script that runs one review per area, with Fable 5.1 as the model:

- **One area per run.** Knowledge (the code index), permissions, tools, sandbox, audit, loop and
  agents. A narrow scope gave more precise findings than "review everything".
- **A copy without the answers.** The script reviews a copy of the code without the docs and
  without the tests that describe known gaps. The model had to find problems in the code, not read
  about them.
- **A fixed format.** For each finding: a title, a severity, `file:line`, a concrete failure
  scenario, and "confirmed in the code" or "likely". At most 15 findings, then the list of files
  that it read.

## What it found

| Area | Cost | Result |
| --- | --- | --- |
| Knowledge | $3.12 | 2 of 4 known gaps found; 11 of 12 findings correct |
| Permissions | $6.47 | All 8 checked findings correct |
| Tools | $6.19 | 14 findings |
| Sandbox | $2.29 | 8 findings |
| Audit | $2.86 | 12 findings |
| Loop | $5.39 | 9 findings, 1 high |
| Agents | $3.27 | 8 findings |

The total was about $30 for the seven runs. Some findings that I fixed:

- **A project could turn off its own safety.** A cloned repository's settings file could set the
  executor to "host" and allow `bash`: every command then ran on the host with no question. Now the
  parts of project settings that loosen safety need a yes at startup, pinned to a hash.
- **API keys were readable from the sandbox.** A sandboxed command could read the provider key from
  `/proc/<pid>/environ` of the Garuda process. Garuda now takes the keys out of its own environment
  at startup, and on Linux each command gets its own process space.
- **A background process could hang a call.** `sleep 30 &` kept the output pipes open, so the call
  waited past its timeout and past Ctrl-C.
- **Subagents escaped the team policy's limits.** The policy capped the steps and tokens of the main
  loop, but a project's settings could give a subagent far more.
- **Gaps in the audit log.** The tool calls of subagents and the hook commands were not recorded,
  and a failed write in mandatory mode crashed the turn.
- **The high one.** After Ctrl-C at an approval question, the conversation kept a tool call with no
  result. The API refused that, so every later message of the chat failed until a restart.

## What I learned

**Check every finding in the code.** The precision was high, but not perfect: one finding marked
"high" was wrong. A finding is a lead, not a fact.

**A self-review is one input, not a proof.** In the knowledge area, the model found two of the four
gaps that I already knew about. The other areas had no such baseline, so I cannot say what it
missed there. The review runs complement the tests and my own reading; they do not replace them.

**Make each fix fail first.** Every fix came with a test, and I ran each test once without its fix
to see it fail. This caught a mistake of my own. My first test for the Ctrl-C bug interrupted a
`bash` call, and it passed without the fix. A stopped `bash` call returns a normal result, so it
never left an open call. The real trigger was Ctrl-C at the approval question, and only a test
of that case failed without the fix.

**The review also tested the agent.** The sandbox review failed twice before it worked. The model
thought for longer than five minutes without output, and the stream timed out. Garuda now waits up
to 20 minutes on a quiet stream. A tool that reviews itself also runs its longest, hardest tasks on
itself.

## The result

The fixes are in 0.14.0, and each one has a test. I wrote them with Claude as a pair programmer.
The suite now has 804 tests, and none of them needs the internet or an API key. The
known limits that are still open are in the
[README](https://github.com/madhu-sv/garuda#status), and the review script is simple to run
again. The next areas are the CLI and the extensions.

If you find a security problem, please report it privately: see
[SECURITY.md](https://github.com/madhu-sv/garuda/blob/main/SECURITY.md).
