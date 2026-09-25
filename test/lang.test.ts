import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Runtime } from "../src/app/runtime.js";
import { buildSystemPrompt } from "../src/context/instructions.js";
import { detectProfiles, profileAccess, profileNotes } from "../src/lang/profiles.js";
import { FakeModelClient, reply, text } from "../src/model/fake.js";
import { AutoApprover } from "../src/permissions/autoApprover.js";
import { PermissionEngine } from "../src/permissions/engine.js";
import { parseSettings } from "../src/permissions/settings.js";
import { FileSessionStore } from "../src/session/store.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "garuda-lang-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const home = "/home/u";

let n = 0;
function project(files: string[], content: Record<string, string> = {}): string {
  const root = join(base, `p${n++}`);
  mkdirSync(root, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content[file] ?? "");
  }
  return root;
}
const detect = (root: string, env: NodeJS.ProcessEnv = {}) => detectProfiles(root, { home, env });

describe("language profiles (0.3)", () => {
  it("finds nothing in a Node project or an empty folder", () => {
    expect(detect(project(["package.json"]))).toEqual([]);
    expect(detect(project([]))).toEqual([]);
  });

  it("Maven: offline test command, Maven wrapper, only the ~/.m2 caches are writable", () => {
    const [maven] = detect(project(["pom.xml"]));
    expect(maven).toMatchObject({ id: "maven", label: "Java (Maven)", test: "mvn -B -q -o test" });
    expect(maven?.access.writePaths).toEqual([`${home}/.m2/repository`, `${home}/.m2/wrapper`]);
    expect(maven?.access.envAllow).toEqual(["JAVA_HOME"]);
    expect(maven?.notes.join("\n")).toMatch(/outside_sandbox: true/);
    expect(detect(project(["pom.xml", "mvnw"]))[0]?.test).toBe("./mvnw -B -q -o test");
  });

  it("Gradle: wrapper, Kotlin DSL, GRADLE_USER_HOME; init scripts and properties stay read-only", () => {
    const [gradle] = detect(project(["build.gradle.kts", "gradlew"]));
    expect(gradle).toMatchObject({ id: "gradle", test: "./gradlew test --offline -q" });
    expect(gradle?.access.writePaths).toContain(`${home}/.gradle/caches`);
    expect(gradle?.access.writePaths).toContain(`${home}/.gradle/wrapper`);
    for (const path of gradle?.access.writePaths ?? []) {
      expect(path).not.toMatch(/init|gradle\.properties$/);
      expect(path).not.toBe(`${home}/.gradle`);
    }
    const custom = detect(project(["settings.gradle"]), { GRADLE_USER_HOME: "/cache/gradle" })[0];
    expect(custom?.test).toBe("gradle test --offline -q");
    expect(custom?.access.writePaths).toContain("/cache/gradle/caches");
    // A relative GRADLE_USER_HOME is ignored.
    const relative = detect(project(["settings.gradle"]), { GRADLE_USER_HOME: "g" })[0];
    expect(relative?.access.writePaths).toContain(`${home}/.gradle/caches`);
  });

  it("Python: picks the interpreter of the project", () => {
    const python = (files: string[], content?: Record<string, string>) =>
      detect(project(files, content))[0]?.test;
    expect(python(["pyproject.toml"])).toBe("python3 -m pytest -q");
    expect(python(["requirements.txt", ".venv/bin/python"])).toBe(".venv/bin/python -m pytest -q");
    expect(python(["setup.py", "venv/bin/python"])).toBe("venv/bin/python -m pytest -q");
    expect(python(["pyproject.toml", "uv.lock"])).toBe("uv run --offline python -m pytest -q");
    expect(python(["pyproject.toml"], { "pyproject.toml": '[tool.poetry]\nname = "x"\n' })).toBe(
      "poetry run python -m pytest -q",
    );
    const [uv] = detect(project(["pyproject.toml", "uv.lock"]));
    expect(uv?.notes.join("\n")).toMatch(/uv\.lock/);
    expect(uv?.access.writePaths).toEqual([`${home}/.local/share/uv`]);
  });

  it("a mixed project gets every profile; access and notes are merged", () => {
    const profiles = detect(project(["pom.xml", "pyproject.toml"]));
    expect(profiles.map((p) => p.id)).toEqual(["maven", "python"]);
    const access = profileAccess(profiles);
    expect(access.writePaths).toContain(`${home}/.m2/repository`);
    expect(access.writePaths).toContain(`${home}/.local/share/uv`);
    expect(access.envAllow).toEqual(["JAVA_HOME", "VIRTUAL_ENV"]);
    expect(profileNotes(profiles)).toMatch(/Maven[\s\S]*Python project/);
    expect(profileNotes([])).toBeUndefined();
  });

  it("the permission engine adds the caches and variables to the exec policy", () => {
    const [maven] = detect(project(["pom.xml"]));
    const permissions = new PermissionEngine({
      root: "/repo",
      approver: new AutoApprover(),
      access: profileAccess(maven === undefined ? [] : [maven]),
    });
    const policy = permissions.execPolicy(5_000);
    expect(policy.writePaths).toContain(`${home}/.m2/repository`);
    expect(policy.writePaths).not.toContain(`${home}/.m2`);
    expect(policy.envAllowlist).toContain("JAVA_HOME");
    const plain = new PermissionEngine({ root: "/repo", approver: new AutoApprover() });
    expect(plain.execPolicy(5_000).writePaths).not.toContain(`${home}/.m2/repository`);
    expect(plain.execPolicy(5_000).envAllowlist).not.toContain("JAVA_HOME");
  });

  it("the system prompt gets a build-and-test section before the project instructions", () => {
    const notes = profileNotes(detect(project(["pom.xml"])));
    const prompt = buildSystemPrompt("/r", "Use tabs.", undefined, {
      sandboxed: true,
      languages: notes,
    });
    expect(prompt).toContain("# Build and test (detected by Garuda)");
    expect(prompt.indexOf("mvn -B -q -o test")).toBeLessThan(prompt.indexOf("Use tabs."));
    expect(prompt).toContain("package caches");
    expect(buildSystemPrompt("/r", undefined)).not.toContain("# Build and test");
  });

  it("the runtime detects the profiles of its root", async () => {
    const root = project(["pyproject.toml"]);
    const runtime = await Runtime.create({
      root,
      modelId: "claude-sonnet-5",
      model: async () => new FakeModelClient([reply([text("ok")])]),
      approver: new AutoApprover("once"),
      store: new FileSessionStore(root),
      settings: parseSettings({}),
      mcp: false,
      hooks: false,
    });
    expect(runtime.profiles.map((p) => p.id)).toEqual(["python"]);
    expect(runtime.system).toContain("python3 -m pytest -q");
    expect(runtime.extras()[0]).toBe("Python");
    runtime.executor.shutdown();
  });
});
