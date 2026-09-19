"use strict";
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const PATH = "/sand-stream-relay/aiserver.v1.InferenceService/Stream";
const REQUEST_HEADERS = ["connect-content-encoding", "connect-accept-encoding", "x-request-id", "x-session-id", "traceparent"];
const RESPONSE_HEADERS = ["content-type", "content-encoding", "connect-content-encoding", "connect-accept-encoding", "grpc-status", "grpc-message"];
function waitAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
exports.createRelay = function createRelay({ httpClient, authorize, getAuth, createChecksum, maxBytes = 64 * 1024 * 1024, timeoutMs = 30 * 60_000, maxConcurrent = 4, allowTestHttp = false }) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error("invalid concurrency");
  let active = 0;
  function error(res, status, message) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: message }));
  }
  return async function relay(deps, req, res) {
    if (req.method !== "POST" || new URL(req.url, "http://localhost").pathname !== PATH) return error(res, 404, "not found");
    if (typeof deps.authToken !== "string" || !deps.authToken || !authorize(req, deps.authToken)) return error(res, 401, "unauthorized");
    if (!/^application\/connect\+proto(?:;|$)/i.test(String(req.headers["content-type"] || ""))) return error(res, 415, "Connect protobuf required");
    if (Number(req.headers["content-length"]) > maxBytes) return error(res, 413, "request too large");
    if (active >= maxConcurrent) return error(res, 429, "relay busy");
    const auth = getAuth();
    if (!auth) return error(res, 503, "inference credential unavailable");
    active++;
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("client disconnected"));
    const close = () => { if (!res.writableFinished) cancel(); };
    req.once("aborted", cancel);
    res.once("close", close);
    const timer = setTimeout(() => controller.abort(new Error("relay deadline")), timeoutMs);
    let phase = "credential", tooLarge = false, response;
    try {
      if (req.aborted || res.destroyed) cancel();
      const token = await waitAbort(Promise.resolve().then(() => auth.getGrokBotToken()), controller.signal);
      if (typeof token !== "string" || !token) throw new Error("credential unavailable");
      const machine = await waitAbort(Promise.resolve().then(() => auth.getMachineId()), controller.signal);
      const target = new URL("/aiserver.v1.InferenceService/Stream", auth.backend.backendUrl);
      if (target.protocol !== "https:" && !(allowTestHttp && target.protocol === "http:" && target.hostname === "127.0.0.1")) throw new Error("invalid backend");
      if (target.username || target.password) throw new Error("invalid backend");
      const header = new Headers({ "content-type": "application/connect+proto", "connect-protocol-version": "1" });
      const requestHop = new Set(String(req.headers.connection || "").toLowerCase().split(",").map(x => x.trim()));
      for (const name of REQUEST_HEADERS) {
        if (requestHop.has(name)) continue;
        const value = req.headers[name];
        if (typeof value === "string" && value.length <= 1024 && /^[\x20-\x7e]*$/.test(value)) header.set(name, value);
      }
      header.set("authorization", `Bearer ${token}`);
      header.set("x-cursor-client-type", "sand");
      header.set("x-cursor-client-source", "sand-desktop");
      header.set("x-cursor-client-version", auth.backend.clientVersion);
      header.set("x-sand-box-namespace", auth.backend.boxNamespace);
      header.set("x-ghost-mode", "true");
      if (typeof machine === "string" && machine) header.set("x-cursor-checksum", createChecksum(machine));
      async function* body() {
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxBytes) { tooLarge = true; throw new Error("request too large"); }
          yield chunk;
        }
      }
      phase = "upstream";
      if (controller.signal.aborted) throw controller.signal.reason;
      response = await waitAbort(httpClient({ url: target.href, method: "POST", header, body: body(), signal: controller.signal }), controller.signal);
      if (response.status >= 300 && response.status < 400) { controller.abort(); return error(res, 502, "upstream redirect refused"); }
      const headers = {};
      const responseHop = new Set((response.header.get("connection") || "").toLowerCase().split(",").map(x => x.trim()));
      for (const name of RESPONSE_HEADERS) {
        if (responseHop.has(name)) continue;
        const value = response.header.get(name);
        if (value !== null) headers[name] = value;
      }
      headers["cache-control"] = "no-store";
      headers["x-oc-sand-box-upstream"] = "1";
      res.writeHead(response.status, headers);
      await pipeline(Readable.from(response.body), res, { signal: controller.signal });
    } catch (cause) {
      error(res, tooLarge ? 413 : controller.signal.aborted ? 504 : phase === "credential" ? 503 : 502,
        tooLarge ? "request too large" : controller.signal.aborted ? "relay cancelled" : phase === "credential" ? "inference credential unavailable" : "upstream inference failed");
    } finally {
      clearTimeout(timer);
      req.off("aborted", cancel);
      res.off("close", close);
      controller.abort();
      active--;
    }
  };
};
