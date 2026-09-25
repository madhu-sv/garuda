import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ENV_ALLOWLIST } from "../permissions/engine.js";
import { HostExecutor } from "../sandbox/host.js";
import { writeFiles } from "./files.js";
import { MAVEN_POM, PYPROJECT } from "./projects.js";

/**
 * Toolchains for the Java and Python eval suites (0.3). A task that needs a toolchain runs only
 * when the toolchain works on this machine: `garuda eval` stops with a hint, and the task
 * self-tests are skipped. Evals never download anything by themselves; `garuda eval --prepare`
 * does it once, with the user's consent.
 */

export type ToolchainId = "maven" | "pytest";

export interface Toolchain {
  id: ToolchainId;
  title: string;
  /** A tiny project whose tests pass when the toolchain works. */
  files: Record<string, string>;
  /** Proves that the toolchain works with no network. */
  probe: string;
  /** Fills the caches (network). Undefined: the user must install the toolchain. */
  prepare?: string;
  /** What the user can do when the probe fails. */
  hint: string;
}

/** Environment variables that the toolchains need, on top of the default list. */
export const TOOLCHAIN_ENV = ["JAVA_HOME", "GRADLE_USER_HOME", "VIRTUAL_ENV"];

export const TOOLCHAINS: Readonly<Record<ToolchainId, Toolchain>> = {
  maven: {
    id: "maven",
    title: "Maven with JUnit 5 in ~/.m2",
    files: {
      "pom.xml": MAVEN_POM,
      "src/main/java/probe/Probe.java":
        "package probe;\n\npublic final class Probe {\n  public static int one() {\n    return 1;\n  }\n}\n",
      "src/test/java/probe/ProbeTest.java":
        "package probe;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass ProbeTest {\n  @Test\n  void one() {\n    assertEquals(1, Probe.one());\n  }\n}\n",
    },
    probe: "mvn -B -q -o test",
    prepare: "mvn -B -q test",
    hint: "The Java tasks need a JDK (17 or later), Maven, and JUnit 5 in ~/.m2. Run `garuda eval --prepare java` once: it downloads the plugins and JUnit with Maven (network).",
  },
  pytest: {
    id: "pytest",
    title: "Python 3 with pytest",
    files: {
      "pyproject.toml": PYPROJECT,
      "src/probe/__init__.py": "def one():\n    return 1\n",
      "tests/test_probe.py": "from probe import one\n\n\ndef test_one():\n    assert one() == 1\n",
    },
    probe: "python3 -m pytest -q -p no:cacheprovider",
    hint: "The Python tasks need python3 with pytest 7 or later. Install it, for example with `python3 -m pip install --user pytest`.",
  },
};

export interface ToolchainStatus {
  id: ToolchainId;
  ok: boolean;
  output: string;
}

const PROBE_TIMEOUT_MS = 120_000;
const PREPARE_TIMEOUT_MS = 10 * 60_000;

/** Run the probe of each toolchain in a scratch folder. */
export async function checkToolchains(ids: readonly ToolchainId[]): Promise<ToolchainStatus[]> {
  return Promise.all(
    [...new Set(ids)].map(async (id) => {
      const toolchain = TOOLCHAINS[id];
      const r = await inScratch(toolchain, toolchain.probe, PROBE_TIMEOUT_MS);
      return { id, ...r };
    }),
  );
}

/** Fill the caches of a toolchain (network). */
export async function prepareToolchain(id: ToolchainId): Promise<{ ok: boolean; output: string }> {
  const toolchain = TOOLCHAINS[id];
  if (toolchain.prepare === undefined) return { ok: false, output: toolchain.hint };
  return inScratch(toolchain, toolchain.prepare, PREPARE_TIMEOUT_MS);
}

/** `java` and `python` are names for people; the ids name the tools. */
export function toolchainId(name: string): ToolchainId | undefined {
  const aliases: Record<string, ToolchainId> = {
    java: "maven",
    maven: "maven",
    python: "pytest",
    pytest: "pytest",
  };
  return aliases[name.toLowerCase()];
}

async function inScratch(
  toolchain: Toolchain,
  command: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  const root = await mkdtemp(join(tmpdir(), `garuda-toolchain-${toolchain.id}-`));
  try {
    await writeFiles(root, toolchain.files);
    const r = await new HostExecutor().run(command, {
      root,
      sandbox: false,
      writePaths: [root],
      denyWritePaths: [],
      denyReadPaths: [],
      network: true,
      envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...TOOLCHAIN_ENV],
      timeoutMs,
      maxOutputBytes: 4_000,
    });
    const output = `${r.stdout.text}${r.stderr.text}`.trim();
    return { ok: r.exitCode === 0 && !r.timedOut, output };
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
