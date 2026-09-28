import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRequest,
  deriveRequirements,
  latestContext,
  profileFor,
  sensitive,
} from "../../../scripts/jev/classification.mjs";
import { routeRequest, withRoutingHeaders } from "../../../scripts/jev/hook.mjs";
import {
  ALIASES,
  PROFILES,
  buildProfileCombo,
  resolveAlias,
} from "../../../scripts/jev/profiles.mjs";

// Explicit synthetic fixtures, NOT verified connected-account/activation evidence.
const now = Date.now();
const evidence = {
  purpose: "classification-only",
  billing: "verified-free",
  model: "jev-1.13-free",
  endpoint: "https://opencode.ai/zen/v1/chat/completions",
  connectionId: "fixture",
  evidenceRef: "fixture-only",
  inferenceVerified: true,
  verifiedAt: new Date(now - 1000).toISOString(),
  validUntil: new Date(now + 60000).toISOString(),
};
const policy = { privacy: { externalClassification: true }, allowedConnectionIds: ["fixture"] };
const body = { model: "smart-router", messages: [{ role: "user", content: "Explain trees" }] };
const result = (
  family = "general",
  complexity = "routine",
  consequence = "medium",
  confidence = 0.9
) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          answers: Object.fromEntries(
            Object.entries({ family, complexity, consequence, latency: "interactive" }).map(
              ([k, choice]) => [k, { choice, confidence }]
            )
          ),
        }),
      },
    },
  ],
});
const options = (data = result()) => ({
  policy,
  evidence,
  credential: "test-fixture",
  fetchImpl: async () => Response.json(data),
});

test("all eight classifications map to distinct profiles", async () => {
  const cases = [
    ["general", "simple", "low", "quick"],
    ["general", "routine", "medium", "general"],
    ["coding", "simple", "low", "code-fast"],
    ["coding", "complex", "high", "code-deep"],
    ...["reasoning", "writing", "structured", "vision"].map((p) => [p, "routine", "medium", p]),
  ];
  for (const [family, complexity, consequence, profile] of cases) {
    const decision = await classifyRequest(body, options(result(family, complexity, consequence)));
    assert.equal(decision.profile, profile);
    assert.equal(decision.metadata.source, "jev");
  }
  assert.equal(
    profileFor({ family: "coding", complexity: "simple", consequence: "high" }),
    "code-deep"
  );
});

test("Chat Completions, Responses and Messages use latest bounded request", async () => {
  for (const request of [
    body,
    {
      model: "auto",
      input: [{ role: "user", content: [{ type: "input_text", text: "Explain trees" }] }],
    },
    {
      model: "auto",
      system: "You explain things",
      messages: [{ role: "user", content: [{ type: "text", text: "Explain trees" }] }],
      max_tokens: 100,
    },
  ]) {
    let outgoing;
    const decision = await classifyRequest(request, {
      ...options(),
      fetchImpl: async (_, init) => {
        outgoing = JSON.parse(init.body);
        return Response.json(result());
      },
    });
    assert.match(outgoing.messages[1].content, /Explain trees/);
    assert.equal(decision.profile, "general");
  }
  const context = latestContext({
    messages: [
      { role: "user", content: "OLD" },
      { role: "assistant", content: "a".repeat(50000) },
      { role: "user", content: "z".repeat(50000) + "LATEST" },
    ],
  });
  assert.ok(context.length < 12000);
  assert.match(context, /LATEST/);
  assert.doesNotMatch(context, /OLD/);
});

test("privacy scans all fields, before truncation, with zero external attempts", async () => {
  const fields = [
    { system: "mail a@example.com" },
    { instructions: "password: fixture" },
    { tools: [{ name: "read", description: "confidential record" }] },
    {
      response_format: { type: "json_schema", json_schema: { description: "patient information" } },
    },
    { metadata: { nested: { credential: "x" } } },
    { extra: ["a@example.com"] },
    { input: [{ type: "function_call_output", output: "secret=x" }] },
    {
      messages: [
        { role: "tool", content: "api_key=x" },
        { role: "user", content: "x".repeat(50000) },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }],
        },
      ],
    },
  ];
  for (const field of fields) {
    let attempts = 0;
    const decision = await classifyRequest(
      { ...body, ...field },
      {
        ...options(),
        fetchImpl: async () => {
          attempts++;
          throw Error();
        },
      }
    );
    assert.equal(attempts, 0);
    assert.equal(decision.metadata.reason, "privacy");
  }
  assert.equal(sensitive({ field: "clean" }), false);
  assert.equal(
    (await classifyRequest(body, { ...options(), policy: {} })).metadata.reason,
    "privacy"
  );
});

test("unknown, paid, OAuth-only, expired, redirected and unverified inference access cannot dispatch", async () => {
  for (const mutation of [
    null,
    { billing: "paid" },
    { billing: "oauth" },
    { inferenceVerified: false },
    { validUntil: new Date(0).toISOString() },
    { endpoint: "https://openrouter.ai/api/v1/chat/completions" },
    { evidenceRef: "" },
    { model: "jev-1.13" },
    { verifiedAt: new Date(now + 10000).toISOString() },
  ]) {
    let calls = 0;
    const decision = await classifyRequest(body, {
      ...options(),
      evidence: mutation === null ? null : { ...evidence, ...mutation },
      fetchImpl: async () => {
        calls++;
      },
    });
    assert.equal(calls, 0);
    assert.equal(decision.metadata.reason, "unverified-access");
  }
});

test("malformed, low-confidence and outage results use deterministic conservative profiles", async () => {
  for (const data of [
    {},
    result("unknown"),
    result("coding", "simple", "low", 0.74),
    result("coding", "simple", "low", "0.99"),
    result("coding", "simple", "low", 2),
  ]) {
    const decision = await classifyRequest({ ...body, input: "debug" }, options(data));
    assert.equal(decision.metadata.source, "local");
    assert.equal(decision.classification.consequence, "high");
    assert.notEqual(decision.profile, "quick");
  }
  for (const fetchImpl of [
    async () => {
      throw Error("secret credential must never escape");
    },
    async () => new Response("outage", { status: 503 }),
    async () => new Response("x".repeat(17000)),
  ]) {
    const d = await classifyRequest(body, { ...options(), fetchImpl });
    assert.equal(d.metadata.reason, "classifier-failed");
    assert.doesNotMatch(JSON.stringify(d), /secret credential/);
  }
  const coding = { ...body, messages: [{ role: "user", content: "debug this function" }] };
  assert.equal((await classifyRequest(coding)).profile, "code-deep");
  assert.deepEqual(await classifyRequest(coding), await classifyRequest(coding));
});

test("deadline bounds both non-cooperative fetch and stalled body; cancellation remains cancellation", async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const started = performance.now();
    const decision = await classifyRequest(body, { ...options(), timeoutMs: 20, fetchImpl });
    assert.equal(decision.metadata.reason, "classifier-failed");
    assert.ok(performance.now() - started < 250);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(classifyRequest(body, { ...options(), signal: controller.signal }), {
    name: "AbortError",
  });
});

test("hard requirements survive classifier output and are immutable", async () => {
  const request = {
    ...body,
    tools: [{ type: "function", function: { name: "read" } }],
    text: { format: { type: "json_schema", schema: { type: "object" } } },
    reasoning: { effort: "high" },
    max_output_tokens: 8000,
    input: [{ type: "input_image", image_url: "https://example.test/a" }],
  };
  const required = deriveRequirements(request, policy);
  const decision = await classifyRequest(request, options(result("general", "simple", "low")));
  assert.deepEqual(decision.requirements, required);
  assert.ok(required.totalContextUpperBound > 8000);
  assert.equal(required.requiresContextVerification, true);
  assert.deepEqual(required.allowedConnectionIds, ["fixture"]);
  assert.throws(() => {
    required.tools.push({});
  });
  assert.throws(() => deriveRequirements({ max_tokens: -1 }));
  assert.equal(
    deriveRequirements({ previous_response_id: "fixture" }).requiresContextVerification,
    true
  );
});

test("canonical aliases normalize case, preserve native auto/* and exclude classifier-only answers", async () => {
  for (const [alias, profile] of Object.entries(ALIASES))
    assert.equal(resolveAlias(` ${alias.toUpperCase()} `).profile, profile);
  for (const model of ["auto/smart", "AUTO/CODING:FAST", "auto/vision"])
    assert.equal(resolveAlias(model).kind, "native");
  for (const model of ["opencode/jev-1.13-free", "openrouter/typesafe/jev-1.13", "jev-1.13-free"])
    await assert.rejects(routeRequest({ ...body, model }));
});

test("concurrent routing and response headers remain request-local for JSON and streaming", async () => {
  const decisions = await Promise.all(
    Array.from({ length: 40 }, async (_, i) => {
      const profile = Object.keys(PROFILES)[i % 8];
      const decision = await routeRequest({ ...body, model: profile });
      await new Promise((r) => setTimeout(r, (40 - i) % 5));
      const response = withRoutingHeaders(new Response(String(i)), decision);
      assert.equal(response.headers.get("x-omniroute-jev-profile"), profile);
      assert.equal(await response.text(), String(i));
      return decision;
    })
  );
  assert.equal(new Set(decisions.map((d) => d.responseHeaders)).size, 40);
});

test("eight existing-model combos enforce quality floors and delegate hard admission without widening", () => {
  const requirements = deriveRequirements(body, policy);
  const candidate = {
    providerId: "fixture-provider",
    model: "fixture/model",
    connectionId: "fixture",
    quality: Object.fromEntries(Object.keys(PROFILES).map((p) => [p, 1])),
    evidence: {
      ...evidence,
      purpose: "generation",
      capabilitiesVerified: true,
      billing: "verified-included",
    },
  };
  for (const profile of Object.keys(PROFILES)) {
    const combo = buildProfileCombo(profile, [candidate], requirements, {
      eligible: (_c, r) => r === requirements,
    });
    assert.equal(combo.name, profile);
    assert.equal(combo.strategy, "auto");
    assert.equal(combo.models.length, 1);
    assert.deepEqual(combo.models[0].allowedConnectionIds, ["fixture"]);
    for (const c of [
      { ...candidate, quality: { [profile]: 0 } },
      { ...candidate, model: "jev-1.13-free" },
      { ...candidate, evidence: { ...candidate.evidence, billing: "paid" } },
      { ...candidate, evidence: {} },
    ])
      assert.equal(
        buildProfileCombo(profile, [c], requirements, { eligible: () => true }).models.length,
        0
      );
    assert.equal(
      buildProfileCombo(profile, [candidate], requirements, { eligible: () => false }).models
        .length,
      0
    );
  }
  assert.throws(() => buildProfileCombo("quick", [candidate], requirements));
});

test("bounded context handles escaped text and preserves tail of newest turn", () => {
  const context = latestContext({ input: "\u0000".repeat(30000) + "TAIL" });
  assert.ok(context.length <= 12000);
  assert.match(context, /TAIL/);
});

test("two-second ceiling is enforced even if a caller requests longer; midflight abort is not fallback", async () => {
  const started = performance.now();
  const d = await classifyRequest(body, {
    ...options(),
    timeoutMs: 60000,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(d.metadata.reason, "classifier-failed");
  assert.ok(performance.now() - started < 2300);
  const controller = new AbortController();
  const pending = classifyRequest(body, {
    ...options(),
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("profile objects normalize through the existing combo model and existing scorer weights", async () => {
  const { normalizeComboStep } = await import("../../../src/lib/combos/steps.ts");
  const { normalizeScoringWeights } =
    await import("../../../open-sse/services/autoCombo/scoring.ts");
  const candidate = {
    providerId: "fixture",
    model: "fixture/model",
    connectionId: "fixture",
    quality: { quick: 1 },
    evidence: { ...evidence, capabilitiesVerified: true, purpose: "generation" },
  };
  const combo = buildProfileCombo("quick", [candidate], deriveRequirements(body), {
    eligible: () => true,
  });
  assert.equal(normalizeComboStep(combo.models[0]).connectionId, "fixture");
  const weights = normalizeScoringWeights(combo.autoConfig.weights);
  assert.equal(weights.latencyInv, 0.7);
  assert.equal(weights.tierPriority, 0);
  assert.equal(weights.costInv, 0);
  assert.equal(weights.health, 0.15000000000000002);
});
