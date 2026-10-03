# Security policy

Garuda runs commands and edits files for a model, so we take security reports seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.14.x | Yes |
| Older | No |

## Report a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting: in this repository, open
**Security**, then **Report a vulnerability**. Give:

- the version (`garuda --version`) and the platform (macOS or Linux, the sandbox in use);
- the steps to reproduce, and what you expected;
- the effect, for example a sandbox escape, a permission or team-policy bypass, a secret in a
  session file or the audit log, or a write that the user did not approve.

You get an answer within 7 days. We agree a fix and a disclosure date with you, and we credit you in
the release notes unless you ask us not to.

## Scope

In scope: the permission engine and the team policy, the OS sandbox (Seatbelt, bubblewrap), the
network allowlist and its proxy, secret redaction, the audit log, and the consent for project
content (hooks, MCP servers, settings, commands, skills, agents).

Known limits are listed in the README under the status table. A report about one of them is still
welcome when it shows a new way to reach the same effect.
