# Reproducible release manifests (#363)

CI produces a versioned JSON manifest for every tracked release input. Each
entry contains the repository path, byte size, and SHA-256 digest; the manifest
also includes a digest over the sorted file list. Generation reads Git's
tracked-file list, sorts paths, and uses no clock or machine-specific metadata,
so identical source trees produce byte-identical output.

Run `npm run verify:release-artifact` for the deterministic-generation and
tamper-detection self-check. To create and verify a manifest locally:

```sh
node scripts/release-artifact.mjs --output .release/manifest.json
node scripts/release-artifact.mjs --verify .release/manifest.json
```

CI generates two manifests and compares them, verifies one against the checked
out source tree, then uploads it as `utix-release-manifest`. Verification fails
if a tracked file is added, removed, or changed. For recovery, restore the
source tree to the intended commit and regenerate the manifest; do not edit a
digest by hand. This is an additive build artifact and does not alter package
or runtime contracts.
