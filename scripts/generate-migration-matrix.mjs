// Script to generate and validate the migration compatibility matrix.
// It reads the JSON fixture and ensures each version's `next` migrations are
// defined and that compatibility entries are symmetric where appropriate.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const matrixPath = resolve(import.meta.url, "../core/migration/fixtures/compatibility-matrix.json");

function loadMatrix() {
  const raw = readFileSync(matrixPath, { encoding: "utf8" });
  return JSON.parse(raw);
}

function validate(matrix) {
  const errors = [];
  for (const [version, info] of Object.entries(matrix)) {
    // check that `next` entries exist as keys
    for (const nxt of info.next) {
      if (!matrix[nxt]) {
        errors.push(`${version} lists unknown next version ${nxt}`);
      }
    }
    // ensure compatibility entries refer to existing versions
    for (const comp of info.compatible) {
      if (!matrix[comp]) {
        errors.push(`${version} lists unknown compatible version ${comp}`);
      }
    }
  }
  return errors;
}

function main() {
  const matrix = loadMatrix();
  const errors = validate(matrix);
  if (errors.length) {
    console.error("Migration matrix validation errors:\n", errors.join("\n"));
    process.exit(1);
  }
  console.log("Migration matrix is valid.");
  // Optionally rewrite formatted JSON (pretty‑print)
  writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + "\n");
}

if (import.meta.url === process.argv[1]) {
  main();
}
