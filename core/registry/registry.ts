import {
  generatedPanels,
  generatedRegistrySchemaVersion
} from "@/core/registry/panels.generated";
import { assertFeatureRegistryVersion } from "@/core/registry/schema";
import { findManifest } from "@/core/registry/manifests";
import type { FeatureEntry } from "@/core/registry/types";

/**
 * Feature lookup used by the `/tools/[slug]` route only.
 *
 * The registry keeps manifest metadata eagerly available for navigation/search,
 * while each entry exposes a lazy loader for the panel implementation. That way
 * the shared nav bundle stays metadata-only and the active tool's code loads on
 * demand.
 */
assertFeatureRegistryVersion(generatedRegistrySchemaVersion, "tool panel registry");

export function findFeature(slug: string): FeatureEntry | undefined {
  const manifest = findManifest(slug);
  const feature = generatedFeatures.find((entry) => entry.manifest.slug === slug);
  if (!manifest || !feature) return undefined;
  return { manifest, load: feature.load };
}

export { featureHref, featureSlugs, manifests, manifestsByCategory } from "@/core/registry/manifests";
