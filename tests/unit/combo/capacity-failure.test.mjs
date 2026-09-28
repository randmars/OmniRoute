import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCapacityExhaustedResponse } from "../../../open-sse/services/combo/capacityFailure.ts";

const now = new Date("2026-09-27T12:00:00.000Z");

test("deduplicates shared pools and emits only verified reset metadata", async () => {
  const response = buildCapacityExhaustedResponse([
    { poolId: "pool_shared_01" },
    { poolId: "pool_shared_01", resetAt: "2026-09-27T12:02:00Z" },
    { poolId: "pool_other_01" },
  ], now);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "120");
  assert.deepEqual((await response.json()).error, {
    code: "capacity_exhausted",
    message: "Included capacity is temporarily unavailable",
    version: 1,
    exhaustedPools: [
      { poolId: "pool_other_01" },
      { poolId: "pool_shared_01", resetAt: "2026-09-27T12:02:00.000Z" },
    ],
    earliestVerifiedResetAt: "2026-09-27T12:02:00.000Z",
    deliveryState: "pre_output",
  });
});

test("unknown reset omits Retry-After", async () => {
  const response = buildCapacityExhaustedResponse([{ poolId: "pool_unknown_01" }], now);
  assert.equal(response.headers.get("Retry-After"), null);
  assert.equal((await response.json()).error.earliestVerifiedResetAt, undefined);
});

test("shared pool uses the later verified reset", async () => {
  const response = buildCapacityExhaustedResponse([
    { poolId: "pool_shared_01", resetAt: "2026-09-27T12:01:00Z" },
    { poolId: "pool_shared_01", resetAt: "2026-09-27T12:03:00Z" },
  ], now);
  assert.equal(response.headers.get("Retry-After"), "180");
  assert.equal((await response.json()).error.exhaustedPools[0].resetAt, "2026-09-27T12:03:00.000Z");
});

test("rejects invalid evidence instead of claiming capacity exhaustion", () => {
  assert.throws(() => buildCapacityExhaustedResponse([], now));
  assert.throws(() => buildCapacityExhaustedResponse([{ poolId: "provider/account-secret" }], now));
  assert.throws(() => buildCapacityExhaustedResponse([
    { poolId: "pool_foo_01", resetAt: "2026-09-27T11:00:00Z" },
  ], now));
  assert.throws(() => buildCapacityExhaustedResponse([
    { poolId: "pool_foo_01", resetAt: "2026-02-30T12:00:00Z" },
  ], now));
  assert.throws(() => buildCapacityExhaustedResponse([
    { poolId: "pool_foo_01", resetAt: "2026-09-27 12:01:00" },
  ], now));
});
