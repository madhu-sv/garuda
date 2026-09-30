/**
 * The network allowlist for commands in the sandbox (0.13, W6). Settings name presets or hosts:
 * `"network": { "allow": ["npm", "pypi", "api.example.com", "*.example.org"] }`. A host pattern
 * with `*.` matches the subdomains, not the domain itself (as web_fetch rules do). Pure.
 */

/** Package registries and code hosts by name. Each lists the hosts its tools download from. */
export const NETWORK_PRESETS: Readonly<Record<string, readonly string[]>> = {
  npm: ["registry.npmjs.org", "registry.yarnpkg.com"],
  pypi: ["pypi.org", "files.pythonhosted.org"],
  maven: ["repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "services.gradle.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
  cargo: ["crates.io", "index.crates.io", "static.crates.io"],
  github: [
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
  ],
};

export const PRESET_NAMES = Object.keys(NETWORK_PRESETS);

/** The ports a command may reach through the proxy. */
export const NETWORK_PORTS: readonly number[] = [80, 443];

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The host patterns of a settings list, and the entries that are neither a preset nor a host. */
export function expandAllowlist(entries: readonly string[]): {
  hosts: string[];
  problems: string[];
} {
  const hosts = new Set<string>();
  const problems: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    const preset = NETWORK_PRESETS[entry];
    if (preset !== undefined) {
      for (const host of preset) hosts.add(host);
    } else if (HOST.test(entry)) {
      hosts.add(entry);
    } else {
      problems.push(
        `"${raw}" is not a preset (${PRESET_NAMES.join(", ")}) or a host name (example.com, *.example.com).`,
      );
    }
  }
  return { hosts: [...hosts], problems };
}

/** True when `host` matches one of the patterns. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

/** One line per entry for the consent and /network: presets with their hosts. */
export function describeAllowlist(entries: readonly string[]): string[] {
  return entries.map((raw) => {
    const preset = NETWORK_PRESETS[raw.trim().toLowerCase()];
    return preset === undefined ? raw : `${raw}: ${preset.join(", ")}`;
  });
}
