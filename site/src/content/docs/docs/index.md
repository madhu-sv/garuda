---
title: Introduction
description: What Garuda is, and how this documentation is organised.
---

Garuda is an open-source coding agent for the terminal. It reads, edits and runs your code with
the model that you choose: Claude, or an open model through Ollama, LM Studio, llama.cpp, vLLM,
OpenRouter or any OpenAI-compatible server.

Garuda is built safety first:

- **Commands run in an OS sandbox.** Seatbelt on macOS, bubblewrap on Linux. They write only in the
  project, the temp folders and the package caches, and they have no network unless you open it.
- **Changes ask first.** An edit shows its diff and a command shows its text. You allow it once, for
  the session, or not at all.
- **Your rules decide.** Deny rules always win. A team policy sets limits that a project cannot
  loosen, and an audit log records every decision.

## How these docs are organised

- **Start here:** [Install](/garuda/docs/install/), [Quick start](/garuda/docs/quick-start/) and the
  [Security model](/garuda/docs/security/).
- **[User guide](/garuda/docs/guide/):** every feature and setting. It is the repository's README.
- **[Design](/garuda/docs/design/):** the architecture, the high-level design and one document per
  component. These pages come from the `docs/` folder of the repository, so they stay the same as
  the code.

Garuda is licensed under the [Apache License 2.0](https://github.com/madhu-sv/garuda/blob/main/LICENSE).
To report a security problem, see [SECURITY.md](https://github.com/madhu-sv/garuda/blob/main/SECURITY.md).
