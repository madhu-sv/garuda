## What changes

<!-- One topic per pull request. What does it change, in a few sentences? -->

## Why

<!-- The problem it solves. Link the issue: "Fixes #123". -->

## How it was tested

<!-- The tests that you added, and how you checked that they fail without the change.
     For a change you tested by hand: the platform (macOS or Linux), the sandbox, and the steps. -->

## Checklist

- [ ] `pnpm check` passes, with zero Biome warnings.
- [ ] A new test fails without the change (undo the change and run it).
- [ ] Tests use temporary folders and a temporary home, no network and no API key.
- [ ] Docs updated: `CHANGELOG.md`, the user guide (`docs/guide/`) and the design docs (`docs/lld/`,
      `docs/hld.md`, `docs/architecture.md`) where they apply.
- [ ] Safety text says exactly what the code does (`test/claims.test.ts` passes).
- [ ] No secrets, keys or personal data in the change.

<!-- A security problem? Do not describe it here. Use SECURITY.md (private reporting). -->
