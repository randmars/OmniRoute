/** Terminal included-capacity response shared with Paperclip's capacity hold. */
import { parseVerifiedInstant } from "./capacityEvidence.ts";
export type ExhaustedCapacityPool = {
  /** Stable opaque quota-pool key; aliases of one pool must use the same key. */
  poolId: string;
  /** Only a verified provider reset instant may be supplied. */
  resetAt?: string;
};

const SAFE_POOL_ID = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Call only after every otherwise-compatible, policy-eligible candidate has
 * been proven exhausted and before client-visible output or tool execution.
 */
export function buildCapacityExhaustedResponse(
  pools: readonly ExhaustedCapacityPool[],
  now: Date = new Date()
): Response {
  if (!Number.isFinite(now.getTime()) || pools.length === 0) {
    throw new Error("capacity_exhausted requires exhausted pools and a valid clock");
  }

  const unique = new Map<string, { poolId: string; resetAt?: string }>();
  for (const pool of pools) {
    if (!SAFE_POOL_ID.test(pool.poolId)) {
      throw new Error("capacity_exhausted requires opaque pool identifiers");
    }
    const resetMs = pool.resetAt === undefined ? null : parseVerifiedInstant(pool.resetAt);
    if (resetMs !== null && (!Number.isFinite(resetMs) || resetMs <= now.getTime())) {
      throw new Error("capacity_exhausted requires future verified reset instants");
    }
    const prior = unique.get(pool.poolId);
    // One alias without a reset cannot erase a verified reset for its pool.
    // Conflicting verified hints for one shared pool must not cause an early probe.
    const latestMs = Math.max(
      prior?.resetAt ? Date.parse(prior.resetAt) : Number.NEGATIVE_INFINITY,
      resetMs ?? Number.NEGATIVE_INFINITY
    );
    unique.set(pool.poolId, {
      poolId: pool.poolId,
      ...(Number.isFinite(latestMs) ? { resetAt: new Date(latestMs).toISOString() } : {}),
    });
  }

  const exhaustedPools = [...unique.values()].sort((a, b) => a.poolId.localeCompare(b.poolId));
  const earliestMs = Math.min(
    ...exhaustedPools.map((pool) => pool.resetAt ? Date.parse(pool.resetAt) : Number.POSITIVE_INFINITY)
  );
  const earliestVerifiedResetAt = Number.isFinite(earliestMs)
    ? new Date(earliestMs).toISOString()
    : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (earliestVerifiedResetAt) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil((earliestMs - now.getTime()) / 1000)));
  }
  return new Response(JSON.stringify({
    error: {
      code: "capacity_exhausted",
      message: "Included capacity is temporarily unavailable",
      version: 1,
      exhaustedPools,
      ...(earliestVerifiedResetAt ? { earliestVerifiedResetAt } : {}),
      deliveryState: "pre_output",
    },
  }), { status: 503, headers });
}
