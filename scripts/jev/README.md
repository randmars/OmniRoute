# JEV routing source package

This package is staged source for RAN-993, based on OmniRoute 3.8.51 commit
77ab3220ccb9c02c258a5978dba2628ec3134494. It is **not installed or activated**.
It preserves Dap's System One choice-question adapter from the runtime scripts,
with strict numeric confidence validation. No paid classifier path is present.

## Request and capacity interface

`routeRequest(body, options)` accepts the original Chat Completions, Responses,
or Messages body. `options` is trusted server context, never request JSON:

- `policy.privacy.externalClassification`: explicit disclosure approval; missing
  or false keeps classification local. Other privacy fields pass through unchanged.
- `policy.allowedConnectionIds`: account policy, retained in requirements.
- `evidence`, `credential`: verified free classifier metadata and runtime secret.
  Evidence must identify classification-only `jev-1.13-free`, the exact OpenCode
  endpoint, a connection and evidence reference, successful inference proof,
  and a validity window no longer than 24 hours. OAuth is not sufficient.
- `signal`: cancellation. `fetchImpl`, `now`, and shorter `timeoutMs` support tests.
  The timeout cannot exceed 2 seconds and covers response reading/validation.

The return value holds `model`, rewritten `body`, `profile`, `classification`,
`requirements`, `metadata` and `responseHeaders`. All are immutable snapshots.
Classification contains family, complexity, consequence, confidence and latency.
Only the model changes in the original body. The classifier sees at most 12,000
serialized context characters, with newest-user-turn priority. The full request
is scanned before extraction and the exact outgoing content is scanned again.
Media is kept local. Sensitivity patterns are defense in depth, not proof that
arbitrary prose is public: trusted disclosure policy is still required.

Requirements preserve tools, tool choice, structured output, input/output
modalities, reasoning settings, privacy and allowed connections. Text context
uses an intentionally conservative byte-based upper bound plus reserved output
(at least 4,096 tokens); media and server-held history set
`requiresContextVerification`. The parent must resolve those counts using the
existing model-specific compatibility path before admission. Never interpret
unknown media/history cost as zero. Never use classifier output to relax any
requirement, caller policy or billing restriction.

`buildProfileCombo(profile, catalog, requirements, { eligible, now })` builds
existing ComboLike/ComboModelStep objects with pinned connection allowlists.
It requires fresh capability/inference/billing evidence and the profile quality
floor, then calls the **capacity sibling's hard admission predicate**. This
callback must synchronously return true only for an eligible account/model.
An empty result means no eligible models; never widen it to all connections.
No catalog entries are bundled: all test entries are explicit synthetic fixtures,
not verified live capabilities. Activation needs a freshly verified connected
catalog and reviewed per-profile quality scores. Existing auto scoring ranks
quota/health/latency after admission; stable provider order breaks ties.

The eight profiles are quick, general, code-fast, code-deep, reasoning, writing,
structured and vision. The case-normalized legacy registry is in `profiles.mjs`.
Explicit `auto/*` is preserved, including `auto/smart`; it still needs the same
hard admission gate. Classifier-only JEV models cannot generate ordinary answers.
The parent must enforce that exclusion after every alias resolution as well.

`withRoutingHeaders(response, decision)` copies safe routing metadata onto JSON
or streamed responses without consuming the stream. Pass the decision through
request-local context; do not retain it globally or forward these headers as
upstream credentials. Remove the old global header-patch path during integration.
Existing core routes are intentionally untouched by this source slice.

## Proxy and lifecycle source

The authenticated, loopback-only proxy exposes `/healthz` and
`POST /v1/systemone`. Its **new version-1 contract** is
`{ version: 1, request: <full original request body> }`; legacy state-only callers
are rejected because they cannot support whole-request privacy inspection.
The response contains decision metadata only, never a generated answer or prompt.
Parent integration must update the hook caller together with the proxy.

The service templates target `%h/omniroute-source` and a protected
`%h/.config/omniroute/jev.env`. Installation requires separate approval and an
operator-selected checkout/runtime path. Required settings are `JEV_PROXY_TOKEN`
and `OMNIROUTE_DB`. Optional settings are `CLASSIFY_PROXY_PORT`,
`OMNIROUTE_LOCAL_API`, `JEV_EVIDENCE_FILE`, `JEV_CLASSIFIER_KEY`, and
`JEV_EXTERNAL_CLASSIFICATION=approved`. Default classifier behavior is local.
Do not put credentials in source, evidence files or logs. Loopback binding means
container callers require an approved local transport; do not expose a host-wide
unauthenticated listener to reproduce the old installation.

The proxy restarts on exit and never kills another port owner. The rehydrator
reads persisted state in read-only SQLite mode on every invocation and preserves
its enabled/disabled value. Its oneshot exits inactive (`RemainAfterExit=no`);
`OnUnitInactiveSec=60s` schedules another run after completion. Each new container
can therefore recover its empty middleware memory. No blind retries follow an
ambiguous PUT. The next tick reapplies the named hook's persisted desired state.
This restores a saved hook; it does **not** install the new classifier hook.

## Verification and integration gate

Run from the task checkout, with isolated development dependencies installed:

```sh
node --import tsx/esm --test tests/unit/jev/*.test.mjs tests/unit/combo/capacity-*.test.mjs
python3 -m unittest discover -s tests/unit/jev -p '*_test.py' -v
```

Tests cover classification and all profiles/formats; whole-request privacy;
malformed and low-confidence results; zero attempts for unknown/paid evidence;
outages, response bounds, timeout and cancellation; immutable requirements;
concurrent metadata; real child-process proxy recreation; and simulated empty
container hook memory backed by temporary SQLite. No live container/systemd test
or external inference was performed. Parent owns full router integration tests,
verified connected-model admission, account/quota fallbacks and canary approval.

Feed `metadata.source`, `metadata.reason`, profile and measured request latency
into the existing metrics surface. Count user requests separately from actual
classifier/provider attempts; this package does not create a second metrics store.

## Rollback and proposed canary

Before any approved activation, snapshot the current hook source, aliases/combo
metadata and affected service units without keys. Preserve the current enablement
state. Stage both old and new source revisions. First run a local fixture canary
across all request formats and forced classifier failures, then seek separate
approval for a narrow live canary with verified included/free candidates.

Rollback means restore the approved safe hook/service revision and saved state,
then verify local fallback and request isolation. **Do not restore the old forced
paid OpenRouter path.** If a safe integrated revision is unavailable, keep JEV
external classification disabled and use the conservative local decision module.
Service restart, deployment, merge and live writes remain separately gated.
