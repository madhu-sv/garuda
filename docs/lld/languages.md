# Language profiles (`src/lang/`)

## Purpose

Help the model build and test Java and Python projects, and let those builds run in the OS sandbox.
Added in 0.3. A profile gives the project's test and build commands, short notes for the system prompt,
and the package caches that sandboxed commands may write.

Profiles do not start hooks and do not install anything.

## Detection (`profiles.ts`)

`detectProfiles(root, { home, env })` checks marker files in the working root only. It does not scan the
tree, so startup stays fast (N3). A project with several markers gets several profiles, in this order.

| Profile | Markers | Test command | Build command |
| --- | --- | --- | --- |
| `maven` — Java (Maven) | `pom.xml` | `mvn -B -q -o test` (`./mvnw` when the wrapper exists) | `mvn -B -q -o compile` |
| `gradle` — Java (Gradle) | `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts` | `gradle test --offline -q` (`./gradlew` when the wrapper exists) | `gradle build -x test --offline -q` |
| `python` — Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pytest.ini`, `tox.ini`, `Pipfile` | `<python> -m pytest -q` | — |

The Python interpreter is the project's own when there is one: `.venv/bin/python`, then
`venv/bin/python`, then `uv run --offline python` (with `uv.lock`), then `poetry run python` (with
`[tool.poetry]` in `pyproject.toml`), else `python3`.

The commands are offline (`-o`, `--offline`), because the sandbox has no network. The notes tell the
model what to do when a dependency is missing: run the same command online with `outside_sandbox: true`,
which the user must approve.

## Prompt notes

`profileNotes(profiles)` joins the notes. `buildSystemPrompt` puts them in a section
`# Build and test (detected by Garuda)`, after the base prompt and before `GARUDA.md`, so the project
owner's instructions can override them. The prompt is built once per process, so the bytes stay the same
on every request (N2).

The banner shows each profile's label in its "extras" line, for example `Java (Maven)`.

## Sandbox access

`profileAccess(profiles)` merges the access of all profiles. The runtime passes it to the permission
engine, which adds it to every `ExecPolicy`.

| Profile | Writable paths (under the home folder) | Environment variables |
| --- | --- | --- |
| `maven` | `.m2/repository`, `.m2/wrapper` | `JAVA_HOME` |
| `gradle` | `.gradle/` `caches`, `wrapper`, `native`, `jdks`, `.tmp`, `notifications`, `workers` (a test process's working folder; under `GRADLE_USER_HOME` when it is an absolute path); not `daemon` (0.20.2, below) | `JAVA_HOME`, `GRADLE_USER_HOME` |
| `python` | `.local/share/uv` | `VIRTUAL_ENV` |

pip, uv and Poetry caches are in `~/.cache` and `~/Library/Caches`, which every sandboxed command may
already write.

Why only these subfolders: `~/.m2/settings.xml`, `~/.gradle/gradle.properties` and `~/.gradle/init.d`
(and `init.gradle`) stay read-only. The build tool reads or runs them later, outside the sandbox, so a
command in the sandbox could otherwise plant code or change where downloads come from. This is the same
reason that `.git/hooks` is read-only. An allowlist of cache folders is also safer than a writable folder
with read-only holes: on Linux, bubblewrap can only protect paths that exist.

`JAVA_TOOL_OPTIONS` and `MAVEN_OPTS` are not passed: they can hold proxy passwords. Add them with
`env.allow` in the settings if a build needs them.

## Limits

- Gradle's daemons (0.20.2, docs/lld/mobile.md): a client finds a running daemon, and its token, in
  `<gradle home>/daemon`. On the user's Mac a sandboxed `./gradlew` handed its build to a daemon that
  the user had started, and the build ran outside the sandbox. So that folder is unreadable and
  unwritable for sandboxed commands (`gradleDaemonPaths`), and `GRADLE_OPTS` gives them their own
  registry (`-Dorg.gradle.daemon.registry.base=<temp>/garuda-gradle-daemon-<uid>`, in the writable temp
  folder, so nothing is made in the home folder): Gradle then
  starts its daemons inside the sandbox. Kotlin's daemon folders are denied for the same reason. A
  command that drops the option fails on the hidden registry; it does not escape.
- A custom Maven repository path (`<localRepository>` in `settings.xml`) is not detected. Add it with
  `sandbox.writePaths` in the settings.
- Only the working root is checked. A multi-module project whose build file is in a subfolder gets no
  profile; `GARUDA.md` can describe its commands.

## Tests

`test/lang.test.ts`: detection for each marker, wrappers, interpreters, `GRADLE_USER_HOME`, the cache
allowlist (no init scripts or properties), merged access, the exec policy of the permission engine, the
prompt section and its place, and profile detection by the runtime.
