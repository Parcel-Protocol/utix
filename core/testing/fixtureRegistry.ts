import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const FEATURES_DIR = path.resolve(process.cwd(), "features");
const FIXTURE_DIR_NAME = "fixtures";
const FIXTURE_FILE_RE = /\.fixture\.tsx?$/;

export interface FixtureFileEntry {
  /** Feature slice this fixture belongs to, e.g. "fee-stats". */
  slice: string;
  /** Absolute path to the fixture file. */
  absolutePath: string;
  /** Path relative to the repo root, used for reporting. */
  relativePath: string;
}

/**
 * Walks `features/*&#47;fixtures/*.fixture.ts(x)` and returns every fixture
 * file found, grouped by the slice that owns it.
 *
 * Fixtures are intentionally decentralized — one directory per slice, owned
 * by that slice's contributor — so this discovers them by walking every
 * feature directory rather than assuming a single shared fixtures root.
 */
export function discoverFixtureFiles(): FixtureFileEntry[] {
  const entries: FixtureFileEntry[] = [];
  let slices: string[];
  try {
    slices = readdirSync(FEATURES_DIR).filter((name) =>
      statSync(path.join(FEATURES_DIR, name)).isDirectory()
    );
  } catch {
    return entries;
  }

  for (const slice of slices) {
    const fixturesDir = path.join(FEATURES_DIR, slice, FIXTURE_DIR_NAME);
    let files: string[];
    try {
      files = readdirSync(fixturesDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!FIXTURE_FILE_RE.test(file)) continue;
      const absolutePath = path.join(fixturesDir, file);
      entries.push({
        slice,
        absolutePath,
        relativePath: path.relative(process.cwd(), absolutePath)
      });
    }
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
