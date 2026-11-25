#!/usr/bin/env node
/** Deterministic source artifact manifest and verifier. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaVersion = 1;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function trackedFiles(projectRoot = root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: projectRoot })
    .toString("utf8").split("\0").filter(Boolean).sort();
}

async function makeManifest(projectRoot = root) {
  const files = [];
  for (const file of trackedFiles(projectRoot)) {
    const content = await readFile(path.join(projectRoot, file));
    files.push({ path: file, sha256: sha256(content), size: content.length });
  }
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const digest = sha256(JSON.stringify(files));
  return { schemaVersion, name: packageJson.name, version: packageJson.version, files, digest };
}

async function verifyManifest(manifest, projectRoot = root) {
  if (!manifest || manifest.schemaVersion !== schemaVersion || !Array.isArray(manifest.files)) {
    throw new Error("Unsupported or malformed release manifest");
  }
  const expected = await makeManifest(projectRoot);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    const expectedPaths = new Set(expected.files.map((file) => file.path));
    const actualPaths = new Set(manifest.files.map((file) => file.path));
    const added = [...expectedPaths].filter((file) => !actualPaths.has(file));
    const removed = [...actualPaths].filter((file) => !expectedPaths.has(file));
    const changed = expected.files.filter((file) => {
      const old = manifest.files.find((item) => item.path === file.path);
      return old && JSON.stringify(old) !== JSON.stringify(file);
    }).map((file) => file.path);
    throw new Error(`Release verification failed (changed: ${changed.join(", ") || "none"}; added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"})`);
  }
  return true;
}

function parseArgs(args) {
  const options = { output: ".release/manifest.json", verify: null, selfTest: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--output") options.output = args[++i];
    else if (args[i] === "--verify") options.verify = args[++i];
    else if (args[i] === "--self-test") options.selfTest = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    const first = await makeManifest();
    const second = await makeManifest();
    if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Self-test: manifest is not deterministic");
    await verifyManifest(first);
    const tampered = structuredClone(first);
    tampered.files[0].sha256 = "0".repeat(64);
    let tamperRejected = false;
    try { await verifyManifest(tampered); } catch { tamperRejected = true; }
    if (!tamperRejected) throw new Error("Self-test: tampered manifest was accepted");
    console.log("Release artifact verifier self-test passed (determinism and tamper detection)");
    return;
  }
  if (options.verify) {
    const input = path.resolve(root, options.verify);
    await verifyManifest(JSON.parse(await readFile(input, "utf8")));
    console.log(`Verified ${input}`);
    return;
  }
  const manifest = await makeManifest();
  const output = path.resolve(root, options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${output} (${manifest.files.length} files, sha256 ${manifest.digest})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
