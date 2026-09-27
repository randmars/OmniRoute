/** Read-only recovery check for a canonical included-capacity pool. */
export type CapacityPoolEvidence = {
  checkedAt: string;
  /** Fingerprints computed from the full, deterministic request requirements. */
  compatibleWith: readonly string[];
  /** True only with account-level evidence that overage cannot be billed. */
  includedOrFree: boolean;
  billingVerified: boolean;
  /** True only when a current quota read proves usable capacity. */
  available: boolean;
  capacityVerified: boolean;
  resetAt?: string;
  resetVerified?: boolean;
};

export type CapacityProbeResult = {
  version: 1;
  poolId: string;
  requirementFingerprint: string;
  checkedAt: string | null;
  compatible: boolean;
  includedOrFree: boolean;
  available: boolean;
  resetAt?: string;
  reason?: "evidence_unavailable" | "exhausted" | "entitlement_missing" | "incompatible";
};

const SAFE_POOL_ID = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * The reader must use entitlement, compatibility, and quota metadata only. It
 * must never invoke a model route. One in-flight read is shared by all aliases
 * of a canonical pool, while compatibility is evaluated for each request.
 */
export function createCapacityProbe(
  readPoolEvidence: (poolId: string) => Promise<CapacityPoolEvidence | null>,
  options: { now?: () => number; maxAgeMs?: number } = {}
): (poolId: string, requirementFingerprint: string) => Promise<CapacityProbeResult> {
  const inFlight = new Map<string, Promise<CapacityPoolEvidence | null>>();
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 5_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("capacity probe requires a positive freshness window");
  }

  return async (poolId, requirementFingerprint) => {
    if (!SAFE_POOL_ID.test(poolId) || !requirementFingerprint) {
      throw new Error("capacity probe requires a canonical pool and requirement fingerprint");
    }
    let read = inFlight.get(poolId);
    if (!read) {
      read = Promise.resolve().then(() => readPoolEvidence(poolId));
      inFlight.set(poolId, read);
      void read.finally(() => {
        if (inFlight.get(poolId) === read) inFlight.delete(poolId);
      }).catch(() => undefined);
    }

    let evidence: CapacityPoolEvidence | null;
    try {
      evidence = await read;
    } catch {
      evidence = null;
    }
    const checkedMs = evidence ? Date.parse(evidence.checkedAt) : NaN;
    const ageMs = now() - checkedMs;
    if (!evidence || !Number.isFinite(checkedMs) || ageMs < 0 || ageMs > maxAgeMs) {
      return {
        version: 1, poolId, requirementFingerprint, checkedAt: null,
        compatible: false, includedOrFree: false, available: false,
        reason: "evidence_unavailable",
      };
    }
    const compatible = evidence.compatibleWith.includes(requirementFingerprint);
    const includedOrFree = evidence.billingVerified === true && evidence.includedOrFree === true;
    const available = compatible && includedOrFree && evidence.capacityVerified === true && evidence.available === true;
    const resetMs = evidence.resetVerified === true && evidence.resetAt
      ? Date.parse(evidence.resetAt)
      : NaN;
    return {
      version: 1,
      poolId,
      requirementFingerprint,
      checkedAt: new Date(checkedMs).toISOString(),
      compatible,
      includedOrFree,
      available,
      ...(!available && Number.isFinite(resetMs) && resetMs > now()
        ? { resetAt: new Date(resetMs).toISOString() }
        : {}),
      ...(!compatible ? { reason: "incompatible" as const }
        : !includedOrFree ? { reason: "entitlement_missing" as const }
        : !available && evidence.capacityVerified !== true ? { reason: "evidence_unavailable" as const }
        : !available ? { reason: "exhausted" as const } : {}),
    };
  };
}
