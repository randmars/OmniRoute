import http from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { routeRequest } from "./hook.mjs";

// Local-only classifier decision endpoint. It cannot proxy ordinary generation.
// New v1 contract accepts the full original request so privacy checks cover ALL fields.
export function createClassifierServer({ token, loadOptions = async () => ({}) } = {}) {
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz")
      return reply(200, { ok: true, service: "jev-decision", contract: 1 });
    if (req.method !== "POST" || req.url !== "/v1/systemone")
      return reply(404, { error: { code: "not_found" } });
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token ?? ""}`);
    if (!token || auth.length !== expected.length || !timingSafeEqual(auth, expected))
      return reply(401, { error: { code: "unauthorized" } });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          reply(413, { error: { code: "request_too_large" } });
          return;
        }
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        input.version !== 1 ||
        !input.request ||
        typeof input.request !== "object" ||
        Array.isArray(input.request)
      )
        return reply(400, { error: { code: "invalid_classifier_contract" } });
      // Config/load failures mean local fallback, never a paid route or raw error body.
      let options = {};
      try {
        options = await loadOptions();
      } catch {
        /* closed default */
      }
      const decision = await routeRequest(input.request, { ...options, signal: controller.signal });
      // No original prompt, requirements content, or credential echoed in proxy response.
      return reply(200, {
        version: 1,
        profile: decision.profile,
        classification: decision.classification,
        metadata: decision.metadata,
        responseHeaders: decision.responseHeaders,
      });
    } catch {
      if (!res.destroyed) reply(400, { error: { code: "invalid_classification_request" } });
    }
  });
}

export async function startFromEnvironment(env = process.env) {
  // Evidence file has metadata only; never reuse OAuth as entitlement proof.
  const token = env.JEV_PROXY_TOKEN;
  if (!token) throw new Error("JEV_PROXY_TOKEN is required");
  const server = createClassifierServer({
    token,
    loadOptions: async () => ({
      evidence: env.JEV_EVIDENCE_FILE
        ? JSON.parse(await readFile(env.JEV_EVIDENCE_FILE, "utf8"))
        : undefined,
      credential: env.JEV_CLASSIFIER_KEY,
      // Explicit operator policy plus per-request sensitivity gate. Closed by default.
      policy: {
        privacy: { externalClassification: env.JEV_EXTERNAL_CLASSIFICATION === "approved" },
      },
    }),
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(Number(env.CLASSIFY_PROXY_PORT ?? 20127), "127.0.0.1");
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment()
    .then((server) => {
      const stop = () => server.close(() => process.exit(0));
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    })
    .catch(() => {
      console.error("classifier startup configuration invalid");
      process.exitCode = 1;
    });
}
