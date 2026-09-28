import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createClassifierServer } from "../../../scripts/jev/systemone-classify-proxy.mjs";

async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
const request = {
  version: 1,
  request: { model: "auto", messages: [{ role: "user", content: "debug function" }] },
};
const init = (data = request) => ({
  method: "POST",
  headers: { Authorization: "Bearer fixture-only" },
  body: JSON.stringify(data),
});

test("proxy authenticates local decisions and ignores client entitlement claims", async (t) => {
  const server = createClassifierServer({ token: "fixture-only" });
  const base = await listening(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal((await fetch(base + "/v1/systemone", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(base + "/v1/chat/completions", init())).status, 404);
  assert.equal(
    (await fetch(base + "/v1/systemone", init({ state: "legacy protocol" }))).status,
    400
  );
  assert.equal(
    (await fetch(base + "/v1/systemone", init({ ...request, request: { model: "jev-1.13-free" } })))
      .status,
    400
  );
  const response = await fetch(
    base + "/v1/systemone",
    init({ ...request, evidence: { billing: "verified-free" }, credential: "fake" })
  );
  const decision = await response.json();
  assert.equal(decision.profile, "code-deep");
  assert.equal(decision.metadata.source, "local");
  assert.doesNotMatch(JSON.stringify(decision), /debug function|fake|fixture-only/);
  assert.equal(
    (await fetch(base + "/v1/systemone", init({ ...request, extra: "x".repeat(2100000) }))).status,
    413
  );
});

test("configuration load failure stays local and never exposes errors", async (t) => {
  const server = createClassifierServer({
    token: "fixture-only",
    loadOptions: async () => {
      throw new Error("fixture private secret");
    },
  });
  const base = await listening(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const text = await (await fetch(base + "/v1/systemone", init())).text();
  assert.match(text, /code-deep/);
  assert.doesNotMatch(text, /private secret/);
});

async function startProcess(port = 0) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { startFromEnvironment } from './scripts/jev/systemone-classify-proxy.mjs';
    const server = await startFromEnvironment({ JEV_PROXY_TOKEN: 'fixture-only', CLASSIFY_PROXY_PORT: '${port}' });
    server.on('listening', () => console.log(server.address().port));
    process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const [data] = await once(child.stdout, "data");
  return { child, port: Number(data.toString().trim()) };
}
async function stopProcess(child) {
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  await stopped;
}

test("classifier starts and recreates on the same port with no state or paid fallback", async () => {
  let port = 0;
  for (let recreation = 0; recreation < 2; recreation++) {
    const process = await startProcess(port);
    port = process.port;
    try {
      assert.ok(port > 0);
      const decision = await (await fetch(`http://127.0.0.1:${port}/v1/systemone`, init())).json();
      assert.equal(decision.metadata.source, "local");
      assert.equal(decision.profile, "code-deep");
    } finally {
      await stopProcess(process.child);
    }
  }
});

test("source timer runs after oneshot exit; proxy restarts without killing a port owner", async () => {
  const dir = "scripts/jev/systemd/";
  const service = await readFile(dir + "omniroute-jev-rehydrate.service", "utf8");
  const timer = await readFile(dir + "omniroute-jev-rehydrate.timer", "utf8");
  const proxy = await readFile(dir + "systemone-classify-proxy.service", "utf8");
  assert.match(service, /Type=oneshot/);
  assert.match(service, /RemainAfterExit=no/);
  assert.match(timer, /OnUnitInactiveSec=60s/);
  assert.doesNotMatch(timer, /OnUnitActiveSec/);
  assert.match(proxy, /Restart=always/);
  assert.doesNotMatch(proxy, /fuser|OpenRouter|openrouter/);
});
