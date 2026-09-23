#!/usr/bin/env node
// Build a standalone `garuda` binary for this machine with Node's single executable
// application support (`node --build-sea`, Node 25.5 or later).
// Usage: pnpm package   →   bin/garuda (bin/garuda.exe on Windows). It runs tsup first.
//
// Some Node builds (for example Homebrew's) have this feature turned off. Then the script
// downloads the official Node build of the same version from nodejs.org, checks its
// SHA-256 sum, keeps it in ~/.cache/garuda, and builds with it.
//   GARUDA_SEA_NODE=/path/to/node   use this Node binary to build
//   NODEJS_ORG_MIRROR=https://...   download from a mirror of nodejs.org/dist

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const output = join(root, "bin", process.platform === "win32" ? "garuda.exe" : "garuda");
const config = join(root, "dist-sea", "sea-config.json");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

function fail(message) {
  console.error(`\npnpm package: ${message}`);
  process.exit(1);
}

/** Pick a Node binary that can build single executables. */
async function seaNode() {
  if (process.env.GARUDA_SEA_NODE) return process.env.GARUDA_SEA_NODE;

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 25 || (major === 25 && minor < 5)) {
    fail(`this needs Node 25.5 or later (you have ${process.version}).`);
  }
  if (process.config.variables.single_executable_application !== false) return process.execPath;

  console.log(`\nThis Node build (${process.execPath}) has single executables turned off.`);
  return officialNode(process.version);
}

/** Download the official Node build once, check it, and return the path of its binary. */
async function officialNode(version) {
  const os = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  if (!os || !arch) {
    fail(
      `no automatic download for ${process.platform}-${process.arch}. Install Node from nodejs.org, or set GARUDA_SEA_NODE.`,
    );
  }

  const name = `node-${version}-${os}-${arch}`;
  const cacheDir = join(homedir(), ".cache", "garuda");
  const binary = join(cacheDir, name, "bin", "node");
  if (existsSync(binary)) {
    console.log(`Using the official Node build in ${join(cacheDir, name)}.`);
    return binary;
  }

  const mirror = (process.env.NODEJS_ORG_MIRROR ?? "https://nodejs.org/dist").replace(/\/$/, "");
  const base = `${mirror}/${version}`;
  const tarball = `${name}.tar.gz`;
  console.log(`Downloading ${base}/${tarball} …`);

  const [sums, archive] = await Promise.all([
    download(`${base}/SHASUMS256.txt`).then((b) => b.toString("utf8")),
    download(`${base}/${tarball}`),
  ]);
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === tarball)?.[0];
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected) fail(`SHASUMS256.txt has no entry for ${tarball}.`);
  if (expected !== actual) fail(`checksum mismatch for ${tarball}. Nothing was installed.`);
  console.log("Checksum OK.");

  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, tarball);
  writeFileSync(archivePath, archive);
  rmSync(join(cacheDir, name), { recursive: true, force: true });
  run("tar", ["-xzf", archivePath, "-C", cacheDir]);
  rmSync(archivePath);
  if (!existsSync(binary)) fail(`the download did not contain ${binary}.`);
  return binary;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`download failed: ${url} (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

const node = await seaNode();

mkdirSync(join(root, "bin"), { recursive: true });
writeFileSync(
  config,
  JSON.stringify(
    {
      main: join(root, "dist-sea", "garuda.cjs"),
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  ),
);
run(node, ["--build-sea", config]);

// macOS runs only signed binaries on Apple silicon. An ad-hoc signature is enough locally.
if (process.platform === "darwin") run("codesign", ["--sign", "-", "--force", output]);

const version = execFileSync(output, ["--version"], { encoding: "utf8" }).trim();
if (readFileSync(join(root, "src", "version.ts"), "utf8").includes(`"${version}"`)) {
  console.log(`\nBuilt ${output} (garuda ${version})\nTry: ${output}`);
} else {
  fail(`the binary reports version "${version}", which does not match src/version.ts.`);
}
