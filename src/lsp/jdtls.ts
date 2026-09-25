import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Eclipse JDT Language Server (jdtls) for Java (0.4). It is a Java program, not one executable:
 * Garuda finds its install folder and a Java 21+ runtime, and builds the `java` command itself.
 * Everything here reads files only; the Executor starts the command (N8).
 *
 * In the sandbox the install folder is read-only, so the OSGi configuration is "shared" and
 * read-only, and jdtls writes its own state under ~/.cache/garuda/jdtls (writable in the sandbox).
 */

/** The version that `garuda lsp install java` downloads. Homebrew's `jdtls` works too. */
export const JDTLS_VERSION = "1.61.0";
export const JDTLS_BASE_URL = `https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}`;
export const JDTLS_MIN_JAVA = 21;

/** Readiness: jdtls sends language/status "Started" when the project import is done. */
export const JDTLS_READY = {
  method: "language/status",
  test: (params: unknown) => {
    const type = (params as { type?: unknown } | null)?.type;
    return type === "Started" || type === "Error";
  },
};

/**
 * Settings for jdtls at initialize. The project stays clean (no .project or .classpath files in
 * it), and Maven and Gradle work offline (the sandbox has no network).
 */
export const JDTLS_INIT_OPTIONS = {
  settings: {
    java: {
      import: {
        generatesMetadataFilesAtProjectRoot: false,
        maven: { offline: { enabled: true } },
        gradle: { offline: { enabled: true } },
      },
      autobuild: { enabled: true },
    },
  },
};

export interface JavaRuntime {
  /** Absolute path of the java program. */
  java: string;
  /** The major version, from the JDK's `release` file. */
  major: number;
}

/** The major version in a JDK `release` file: JAVA_VERSION="21.0.2" → 21, "1.8.0" → 8. */
export function releaseMajor(text: string): number | undefined {
  const match = /^JAVA_VERSION="([^"]+)"/m.exec(text);
  if (match?.[1] === undefined) return undefined;
  const parts = match[1].split(".").map((p) => Number.parseInt(p, 10));
  const major = parts[0] === 1 ? parts[1] : parts[0];
  return major !== undefined && Number.isFinite(major) ? major : undefined;
}

/** A JDK home → its java program and major version, or undefined. */
function runtimeAt(home: string): JavaRuntime | undefined {
  const java = join(home, "bin", "java");
  const release = join(home, "release");
  if (!existsSync(java) || !existsSync(release)) return undefined;
  const major = releaseMajor(readFileSync(release, "utf8"));
  return major === undefined ? undefined : { java, major };
}

export interface JavaSearch {
  /** Garuda's own environment: JAVA_HOME and PATH. */
  env?: NodeJS.ProcessEnv;
  /** JAVA_HOME values found in a launcher script (Homebrew writes one). */
  hints?: string[];
  /** Folders with JDKs; default: the usual macOS and Linux places. */
  jdkFolders?: string[];
}

const JDK_FOLDERS = [
  "/Library/Java/JavaVirtualMachines",
  "/opt/homebrew/opt",
  "/usr/local/opt",
  "/usr/lib/jvm",
];

/**
 * The first Java runtime of version 21 or later: JAVA_HOME, the launcher's hints, `java` on PATH
 * (its real path), then the usual JDK folders. None: undefined.
 */
export function findJava(search: JavaSearch = {}): JavaRuntime | undefined {
  const env = search.env ?? process.env;
  const homes: string[] = [];
  if (env.JAVA_HOME) homes.push(env.JAVA_HOME);
  homes.push(...(search.hints ?? []));
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const java = join(dir, "java");
    if (!existsSync(java)) continue;
    try {
      homes.push(dirname(dirname(realpathSync(java))));
    } catch {
      // A broken link: skip it.
    }
  }
  for (const folder of search.jdkFolders ?? JDK_FOLDERS) {
    let names: string[] = [];
    try {
      names = readdirSync(folder).sort().reverse();
    } catch {
      continue;
    }
    for (const name of names) {
      homes.push(
        join(folder, name),
        join(folder, name, "Contents", "Home"),
        join(folder, name, "libexec", "openjdk.jdk", "Contents", "Home"),
      );
    }
  }
  for (const home of homes) {
    const runtime = runtimeAt(home);
    if (runtime !== undefined && runtime.major >= JDTLS_MIN_JAVA) return runtime;
  }
  return undefined;
}

/**
 * The install folder of a jdtls launcher script: the folder with `plugins/` and `config_*`.
 * Tries the real path's parent, a `libexec` beside it (Homebrew), and absolute paths in the script.
 */
export function jdtlsHome(script: string): { home: string; hints: string[] } | undefined {
  let real = script;
  try {
    real = realpathSync(script);
  } catch {
    return undefined;
  }
  let text = "";
  try {
    text = readFileSync(real, "utf8").slice(0, 20_000);
  } catch {
    // Not readable: only the folder checks below.
  }
  const quoted = [...text.matchAll(/["'](\/[^"'\s]+)["']/g)].map((m) => m[1] as string);
  const hints = [...text.matchAll(/JAVA_HOME[=:]\s*["']?(\/[^"'\s]+)/g)].map((m) => m[1] as string);
  const up = dirname(dirname(real));
  const candidates = [
    up,
    join(up, "libexec"),
    ...quoted.flatMap((p) => [p, dirname(p), dirname(dirname(p))]),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "plugins")) && launcherJar(dir) !== undefined) {
      return { home: dir, hints };
    }
  }
  return undefined;
}

function launcherJar(home: string): string | undefined {
  try {
    const jar = readdirSync(join(home, "plugins")).find(
      (n) => n.startsWith("org.eclipse.equinox.launcher_") && n.endsWith(".jar"),
    );
    return jar === undefined ? undefined : join(home, "plugins", jar);
  } catch {
    return undefined;
  }
}

/** The config folder for this OS and CPU: config_mac_arm, config_mac, config_linux … */
export function configDir(
  home: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
  const names = arch === "arm64" ? [`config_${os}_arm`, `config_${os}`] : [`config_${os}`];
  return names.map((n) => join(home, n)).find((p) => existsSync(p));
}

export interface JdtlsLaunchContext {
  root: string;
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  jdkFolders?: string[];
}

/** The java command that starts jdtls for this root, or the reason it cannot start. */
export function jdtlsLaunch(
  script: string,
  context: JdtlsLaunchContext,
): { argv: string[] } | { problem: string } {
  const install = jdtlsHome(script);
  if (install === undefined) return { problem: `no jdtls install folder (plugins/) for ${script}` };
  const jar = launcherJar(install.home) as string;
  const config = configDir(install.home, context.platform, context.arch);
  if (config === undefined) return { problem: `no config_* folder in ${install.home}` };
  const java = findJava({
    ...(context.env === undefined ? {} : { env: context.env }),
    hints: install.hints,
    ...(context.jdkFolders === undefined ? {} : { jdkFolders: context.jdkFolders }),
  });
  if (java === undefined) {
    return { problem: `jdtls needs Java ${JDTLS_MIN_JAVA} or later; set JAVA_HOME to such a JDK` };
  }
  const cache = join(context.home, ".cache", "garuda", "jdtls");
  const id = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  return {
    argv: [
      java.java,
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      // The install is read-only in the sandbox: its configuration is shared, ours is in the cache.
      `-Dosgi.sharedConfiguration.area=${config}`,
      "-Dosgi.sharedConfiguration.area.readOnly=true",
      "-Dosgi.checkConfiguration=true",
      "-Dosgi.configuration.cascaded=true",
      "-Dlog.level=WARNING",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      jar,
      "-configuration",
      join(cache, `config-${id(install.home)}`),
      "-data",
      join(cache, "workspace", id(context.root)),
    ],
  };
}

/**
 * The managed install: download the pinned milestone from download.eclipse.org and unpack it into
 * <dir>/jdtls. The file name has a build time stamp, so it comes from latest.txt (or the folder
 * listing). A .sha256 file, when the server has one, must match.
 */
export function jdtlsInstallCommand(dir: string, quote: (s: string) => string): string {
  const d = quote(dir);
  return [
    `cd ${d}`,
    `B=${JDTLS_BASE_URL}`,
    `f=$(curl -fsSL "$B/latest.txt" 2>/dev/null || curl -fsSL "$B/" | grep -o 'jdt-language-server-[0-9.]*-[0-9]*\\.tar\\.gz' | head -1)`,
    `test -n "$f" || { echo "No jdtls ${JDTLS_VERSION} file at $B" >&2; exit 1; }`,
    `curl -fsSL -o jdtls.tar.gz "$B/$f"`,
    `if want=$(curl -fsSL "$B/$f.sha256" 2>/dev/null); then got=$( (sha256sum jdtls.tar.gz 2>/dev/null || shasum -a 256 jdtls.tar.gz) | cut -d' ' -f1); test "$(echo "$want" | cut -d' ' -f1)" = "$got" || { echo "Checksum mismatch for $f" >&2; exit 1; }; fi`,
    "rm -rf jdtls && mkdir jdtls && tar -xzf jdtls.tar.gz -C jdtls && rm jdtls.tar.gz",
  ].join(" && ");
}
