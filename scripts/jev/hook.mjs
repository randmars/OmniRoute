import { classifyRequest, deriveRequirements, freeze } from "./classification.mjs";
import { classifierOnly, resolveAlias } from "./profiles.mjs";

/** Server-owned options must not be merged from body/headers. Caller retains this decision
 * in its request context and passes requirements through all selection/retry paths. */
export async function routeRequest(body, options = {}) {
  if (classifierOnly(body.model))
    throw new TypeError("classifier-only model cannot generate answers");
  const alias = resolveAlias(body.model);
  const decision =
    alias.kind === "profile" && alias.profile === "classify"
      ? await classifyRequest(body, options)
      : {
          profile: alias.kind === "profile" ? alias.profile : null,
          classification: null,
          requirements: deriveRequirements(body, options.policy),
          metadata: { source: "explicit", reason: alias.kind },
        };
  const model = decision.profile ?? alias.model;
  return freeze({
    ...decision,
    model,
    body: { ...structuredClone(body), model },
    responseHeaders: {
      "x-omniroute-jev-profile": decision.profile ?? "explicit",
      "x-omniroute-jev-source": decision.metadata.source,
      "x-omniroute-jev-reason": decision.metadata.reason,
    },
  });
}

// Works for JSON and streams, without buffering or shared mutable response headers.
export function withRoutingHeaders(response, decision) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(decision.responseHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
