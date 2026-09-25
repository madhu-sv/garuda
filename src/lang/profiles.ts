import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Language profiles (0.3). Garuda looks at marker files in the working root (no deep scan, so
 * startup stays fast, N3) and finds the build tool of the project. A profile gives:
 *
 * - `test` and `build`: the commands for this project, run in the working root.
 * - `notes`: short lines for the system prompt, so the model uses the right commands.
 * - `access`: package caches that commands in the sandbox may write, and environment variables
 *   that commands may see. Only caches: settings files and init scripts stay read-only,
 *   because the build tool reads or runs them later, outside the sandbox.
 *
 * The profiles do not start hooks and do not install anything.
 */

export type ProfileId = "maven" | "gradle" | "python";

export interface LanguageProfile {
  id: ProfileId;
  /** For people, for example "Java (Maven)". */
  label: string;
  test: string;
  build?: string;
  notes: string[];
  access: ProfileAccess;
}

export interface ProfileAccess {
  /** Absolute paths that sandboxed commands may write. */
  writePaths: string[];
  /** Environment variables that commands may see. */
  envAllow: string[];
}

export interface DetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const MAVEN_MARKERS = ["pom.xml"];
const GRADLE_MARKERS = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
];
const PYTHON_MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "pytest.ini",
  "tox.ini",
  "Pipfile",
];

/** Environment variables that Java and Python tools read to find themselves. No secrets. */
const JAVA_ENV = ["JAVA_HOME"];
const GRADLE_ENV = ["JAVA_HOME", "GRADLE_USER_HOME"];
const PYTHON_ENV = ["VIRTUAL_ENV"];

/**
 * The caches under the home folder that builds write. Only these subfolders: for example
 * ~/.m2/settings.xml and ~/.gradle/init.d stay read-only.
 */
const MAVEN_CACHES = [".m2/repository", ".m2/wrapper"];
const GRADLE_CACHES = ["caches", "wrapper", "daemon", "native", "jdks", ".tmp", "notifications"];
/** pip and uv caches are under ~/.cache and ~/Library/Caches, which every profile may write. */
const PYTHON_CACHES = [".local/share/uv"];

/** Profiles for the project in `root`, in a fixed order. Empty when nothing matches. */
export function detectProfiles(root: string, options: DetectOptions = {}): LanguageProfile[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const has = (name: string) => existsSync(join(root, name));
  const profiles: LanguageProfile[] = [];

  if (MAVEN_MARKERS.some(has)) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    profiles.push({
      id: "maven",
      label: "Java (Maven)",
      test: `${mvn} -B -q -o test`,
      build: `${mvn} -B -q -o compile`,
      notes: [
        `Java project with Maven (pom.xml). Run the tests with \`${mvn} -B -q -o test\`; one test class: \`${mvn} -B -q -o test -Dtest=ClassName\`.`,
        "Sources are in src/main/java and tests in src/test/java. The package path must match the folder path.",
        "-o (offline) uses the downloaded dependencies in ~/.m2. If Maven reports a missing dependency, run the",
        "same command without -o and with outside_sandbox: true, so the user can approve the download.",
      ],
      access: {
        writePaths: MAVEN_CACHES.map((p) => join(home, p)),
        envAllow: JAVA_ENV,
      },
    });
  }

  if (GRADLE_MARKERS.some(has)) {
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    const gradleHome = userHome(env.GRADLE_USER_HOME, join(home, ".gradle"));
    profiles.push({
      id: "gradle",
      label: "Java (Gradle)",
      test: `${gradle} test --offline -q`,
      build: `${gradle} build -x test --offline -q`,
      notes: [
        `Java project with Gradle. Run the tests with \`${gradle} test --offline -q\`; one test class:`,
        `\`${gradle} test --offline -q --tests ClassName\`. --offline uses the downloaded dependencies. If Gradle`,
        "reports a missing dependency, run the command without --offline and with outside_sandbox: true.",
      ],
      access: {
        writePaths: GRADLE_CACHES.map((p) => join(gradleHome, p)),
        envAllow: GRADLE_ENV,
      },
    });
  }

  if (PYTHON_MARKERS.some(has)) {
    const runner = pythonRunner(root, has);
    profiles.push({
      id: "python",
      label: "Python",
      test: `${runner} -m pytest -q`,
      notes: [
        `Python project. Run the tests with \`${runner} -m pytest -q\`; one test: \`${runner} -m pytest -q path/test_x.py::test_name\`.`,
        ...(has("uv.lock")
          ? ["The project uses uv (uv.lock). Do not change uv.lock by hand."]
          : []),
        "Do not install packages in the sandbox: it has no network. Ask the user first.",
      ],
      access: {
        writePaths: PYTHON_CACHES.map((p) => join(home, p)),
        envAllow: PYTHON_ENV,
      },
    });
  }

  return profiles;
}

/** The Python interpreter for this project: its virtual environment when it has one. */
function pythonRunner(root: string, has: (name: string) => boolean): string {
  if (has(".venv/bin/python")) return ".venv/bin/python";
  if (has("venv/bin/python")) return "venv/bin/python";
  if (has("uv.lock")) return "uv run --offline python";
  if (usesPoetry(root)) return "poetry run python";
  return "python3";
}

function usesPoetry(root: string): boolean {
  try {
    return /^\[tool\.poetry\]/m.test(readFileSync(join(root, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

function userHome(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/** The access of all profiles together. */
export function profileAccess(profiles: readonly LanguageProfile[]): ProfileAccess {
  return {
    writePaths: [...new Set(profiles.flatMap((p) => p.access.writePaths))],
    envAllow: [...new Set(profiles.flatMap((p) => p.access.envAllow))],
  };
}

/** The system prompt section for the profiles. Undefined when there are none. */
export function profileNotes(profiles: readonly LanguageProfile[]): string | undefined {
  if (profiles.length === 0) return undefined;
  return profiles.flatMap((p) => p.notes).join("\n");
}
