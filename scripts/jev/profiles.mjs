import { freeze } from "./classification.mjs";

// Quality is a reviewed 0..1 capability score, not price or the provider's marketing tier.
export const PROFILES = freeze({
  quick: { qualityFloor: 0.65, latencyWeight: 0.7 },
  general: { qualityFloor: 0.8, latencyWeight: 0.4 },
  "code-fast": { qualityFloor: 0.8, latencyWeight: 0.6 },
  "code-deep": { qualityFloor: 0.95, latencyWeight: 0.15 },
  reasoning: { qualityFloor: 0.95, latencyWeight: 0.1 },
  writing: { qualityFloor: 0.85, latencyWeight: 0.3 },
  structured: { qualityFloor: 0.9, latencyWeight: 0.3 },
  vision: { qualityFloor: 0.9, latencyWeight: 0.3 },
});
export const ALIASES = freeze({
  ...Object.fromEntries(Object.keys(PROFILES).map((p) => [p, p])),
  "free-tier*": "quick",
  "frontier*": "reasoning",
  free: "quick",
  simple: "quick",
  "free-tier-backstop": "quick",
  cheap: "general",
  basic: "general",
  medium: "general",
  premium: "reasoning",
  complex: "code-deep",
  "frontier-fallback": "reasoning",
  "smart-router": "classify",
  smart_router: "classify",
  jev: "classify",
  systemone: "classify",
  "system-one": "classify",
  auto: "classify",
});
export function resolveAlias(model) {
  const normalized = String(model ?? "")
    .trim()
    .toLowerCase();
  if (normalized.startsWith("auto/")) return { kind: "native", model: normalized };
  if (Object.hasOwn(ALIASES, normalized)) return { kind: "profile", profile: ALIASES[normalized] };
  for (const [alias, profile] of Object.entries(ALIASES)) {
    if (alias.endsWith("*") && normalized.startsWith(alias.slice(0, -1))) {
      return { kind: "profile", profile };
    }
  }
  return { kind: "explicit", model };
}
export function classifierOnly(model, evidence) {
  return evidence?.purpose === "classification-only" || /(?:^|\/)jev(?:-|$)/i.test(String(model));
}

/** Build existing ComboLike/ComboModelStep objects; never select or dispatch a provider.
 * eligible must call the capacity sibling's hard account/compatibility admission gate.
 * Keep this gate on EVERY attempt after parent integration, including native auto/*.
 */
export function buildProfileCombo(
  profile,
  catalog,
  requirements,
  { eligible, now = Date.now() } = {}
) {
  if (!Object.hasOwn(PROFILES, profile)) throw new TypeError("unknown profile");
  if (typeof eligible !== "function") throw new TypeError("hard admission gate required");
  const spec = PROFILES[profile];
  const admitted = catalog.filter((c) => {
    const e = c.evidence;
    return (
      e &&
      e.capabilitiesVerified === true &&
      e.inferenceVerified === true &&
      typeof e.evidenceRef === "string" &&
      e.evidenceRef &&
      Date.parse(e.verifiedAt) <= now &&
      Date.parse(e.validUntil) > now &&
      Date.parse(e.validUntil) - Date.parse(e.verifiedAt) <= 24 * 3600 * 1000 &&
      ["verified-free", "verified-included"].includes(e.billing) &&
      typeof c.connectionId === "string" &&
      c.connectionId &&
      typeof c.model === "string" &&
      typeof c.providerId === "string" &&
      !classifierOnly(c.model, e) &&
      Number.isFinite(c.quality?.[profile]) &&
      c.quality[profile] >= spec.qualityFloor &&
      c.quality[profile] <= 1 &&
      eligible(c, requirements) === true
    );
  });
  // Stable provider order only breaks score ties. Existing auto scorer owns latency/availability.
  admitted.sort((a, b) => (a.providerOrder ?? 0) - (b.providerOrder ?? 0));
  return {
    name: profile,
    strategy: "auto",
    models: admitted.map((c, i) => ({
      id: `${profile}-${i}`,
      kind: "model",
      model: c.model,
      providerId: c.providerId,
      connectionId: c.connectionId,
      allowedConnectionIds: [c.connectionId],
      weight: 1,
    })),
    autoConfig: {
      explorationRate: 0,
      weights: {
        quota: (1 - spec.latencyWeight) / 2,
        health: (1 - spec.latencyWeight) / 2,
        latencyInv: spec.latencyWeight,
      },
    },
    config: {
      jev: { version: 1, profile, qualityFloor: spec.qualityFloor, admissionRequired: true },
    },
  };
}
