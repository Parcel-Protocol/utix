#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

async function walk(dir) {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(absolute)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

function resolveSpecifier(file, specifier, projectRoot) {
  if (specifier.startsWith("@/")) return path.resolve(projectRoot, specifier.slice(2));
  if (specifier.startsWith(".")) return path.resolve(path.dirname(file), specifier);
  return null;
}

export async function findFeatureBoundaryViolations(projectRoot = root) {
  const featuresRoot = path.join(projectRoot, "features");
  const exceptionsPath = path.join(projectRoot, "scripts", "feature-boundary-exceptions.json");
  const exceptions = new Set();
  if (projectRoot === root) {
    const configured = JSON.parse(await readFile(exceptionsPath, "utf8"));
    for (const entry of configured.exceptions ?? []) exceptions.add(`${entry.owner}->${entry.target}`);
  }
  const violations = [];
  for (const file of await walk(featuresRoot)) {
    const owner = path.relative(featuresRoot, file).split(path.sep)[0];
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      const resolved = resolveSpecifier(file, specifier, projectRoot);
      if (!resolved) continue;
      const relative = path.relative(featuresRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const segments = relative.split(path.sep);
      // Root-level feature infrastructure (for example features/manifest.ts)
      // is not a slice and therefore is not a cross-slice dependency.
      if (segments.length < 2) continue;
      const target = segments[0];
      if (target && target !== owner && !exceptions.has(`${owner}->${target}`)) {
        violations.push({
          file: path.relative(projectRoot, file),
          owner,
          target,
          specifier
        });
      }
    }
  }
  return violations;
}

async function main() {
  const violations = await findFeatureBoundaryViolations();
  if (!violations.length) {
    console.log("[boundaries] OK: feature slices import only themselves, core, or packages.");
    return;
  }
  console.error("[boundaries] Cross-feature imports are forbidden:");
  for (const violation of violations) {
    console.error(
      `  ${violation.file}: ${violation.owner} -> ${violation.target} (${violation.specifier})`
    );
  }
  console.error("Move shared behavior to core/, or add a reviewed, reasoned exception to scripts/feature-boundary-exceptions.json.");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
