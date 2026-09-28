import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapacityProbe } from "../../../open-sse/services/combo/capacityProbe.ts";

const now = Date.parse("2026-09-27T12:00:00.000Z");
const fresh = {
  checkedAt: new Date(now).toISOString(),
  compatibleWith: ["request-a"],
  includedOrFree: true,
  billingVerified: true,
  available: true,
  capacityVerified: true,
};

test("shares one metadata read per pool but evaluates compatibility per request", async () => {
  let reads = 0;
  const probe = createCapacityProbe(async () => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return fresh;
  }, { now: () => now });
  const [a, b] = await Promise.all([
    probe("pool_shared_01", "request-a"),
    probe("pool_shared_01", "request-b"),
  ]);
  assert.equal(reads, 1);
  assert.deepEqual(a, {
    version: 1, poolId: "pool_shared_01", requirementFingerprint: "request-a",
    checkedAt: fresh.checkedAt, compatible: true, includedOrFree: true, available: true,
  });
  assert.equal(b.compatible, false);
  assert.equal(b.available, false);
  assert.equal(b.reason, "incompatible");
});

test("stale, future, or missing evidence never resumes work", async () => {
  for (const evidence of [
    { ...fresh, checkedAt: new Date(now - 6_000).toISOString() },
    { ...fresh, checkedAt: new Date(now + 1).toISOString() },
    { ...fresh, compatibleWith: undefined },
    null,
  ]) {
    const result = await createCapacityProbe(async () => evidence, { now: () => now })("pool_shared_01", "request-a");
    assert.equal(result.available, false);
    assert.equal(result.checkedAt, null);
  }
});

test("unknown billing or capacity and reader errors fail closed", async () => {
  for (const evidence of [
    { ...fresh, billingVerified: false },
    { ...fresh, includedOrFree: false },
    { ...fresh, capacityVerified: false },
    { ...fresh, available: false },
  ]) {
    const result = await createCapacityProbe(async () => evidence, { now: () => now })("pool_shared_01", "request-a");
    assert.equal(result.available, false);
  }
  const failed = createCapacityProbe(async () => { throw new Error("quota reader unavailable"); }, { now: () => now });
  assert.equal((await failed("pool_shared_01", "request-a")).available, false);
});

test("only verified future reset is returned", async () => {
  const probe = createCapacityProbe(async () => ({
    ...fresh, available: false, resetAt: new Date(now + 60_000).toISOString(), resetVerified: true,
  }), { now: () => now });
  const result = await probe("pool_shared_01", "request-a");
  assert.equal(result.resetAt, new Date(now + 60_000).toISOString());
  assert.equal(result.reason, "exhausted");
  const unverified = createCapacityProbe(async () => ({
    ...fresh, available: false, resetAt: new Date(now + 60_000).toISOString(), resetVerified: false,
  }), { now: () => now });
  assert.equal((await unverified("pool_shared_01", "request-a")).resetAt, undefined);
});

test("reset is absent without proven exhaustion and canonical time", async () => {
  const resetAt = new Date(now + 60_000).toISOString();
  for (const evidence of [
    { ...fresh, available: false, capacityVerified: false, resetAt, resetVerified: true },
    { ...fresh, available: false, includedOrFree: false, resetAt, resetVerified: true },
    { ...fresh, available: false, compatibleWith: [], resetAt, resetVerified: true },
    { ...fresh, available: false, resetAt: "2026-02-30T12:00:00Z", resetVerified: true },
    { ...fresh, available: false, resetAt: "2026-09-27 12:01:00", resetVerified: true },
  ]) {
    const result = await createCapacityProbe(async () => evidence, { now: () => now })("pool_shared_01", "request-a");
    assert.equal(result.resetAt, undefined);
  }
});

test("rejects route aliases and missing requirement fingerprints", async () => {
  const probe = createCapacityProbe(async () => fresh, { now: () => now });
  await assert.rejects(() => probe("provider/account", "request-a"));
  await assert.rejects(() => probe("pool_shared_01", ""));
});
