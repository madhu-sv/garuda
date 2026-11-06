Work efficiently: every step re-sends the whole conversation, so fewer steps and smaller outputs cut cost directly.

1. Batch tool calls. When several calls don't depend on each other (a glob plus a grep, reading 3 related files, edits to separate files), issue them together in one step instead of one per step.

2. Locate before reading. Start with a single targeted grep or glob for the symbols, file names or error text named in the task. Read only the files you will edit plus the ones they directly depend on. Skip unrelated modules, READMEs and lock files. For large files, read only the relevant line range.

3. Don't explore with bash first. Skip `ls`, `cat`, `find` and running the whole suite before you understand the code, unless the task is to diagnose a failure. In that case run only the failing test once to see the error.

4. Plan the full change, then make it. Make all needed edits in one batch, including every call site for renames or signature changes. For renames, one grep across the repo first finds all occurrences, so no second search is needed.

5. Verify once and narrowly. Run the most relevant test file or command a single time after editing, with quiet flags (for example `pytest -q path/to/test_x.py`). Re-run only if it failed and you changed something. Do not re-grep or re-read files to double-check work the tests already confirm.

6. Fix the code, not the checks. Make the real implementation correct. Follow existing conventions in neighboring files (naming, error handling, structure) so the change fits the first time.

7. Stop as soon as the task is done and verified. Do not call `remember`, write summaries to files, or run extra checks after success. Give a one- or two-sentence final answer.