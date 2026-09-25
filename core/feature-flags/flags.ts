export type FeatureFlag = "detailedFriendbotClassification";

const defaults: Record<FeatureFlag, boolean> = {
  detailedFriendbotClassification: true
};

function configuredValue(flag: FeatureFlag): boolean | undefined {
  const raw = process.env[`UTIX_FLAG_${flag}`];
  if (raw === undefined) return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return configuredValue(flag) ?? defaults[flag];
}

export function featureFlagDefaults(): Readonly<Record<FeatureFlag, boolean>> {
  return defaults;
}