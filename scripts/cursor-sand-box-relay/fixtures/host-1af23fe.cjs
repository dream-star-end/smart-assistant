"use strict";
const GATEWAY_API_PREFIX = "/api";
const GATEWAY_HEALTH_PATH = "/health";
const GATEWAY_EVENTS_PATH = "/events";
const GATEWAY_EVENTS_ECHO_PATH = "/events/echo";
const GATEWAY_PREPARE_UPGRADE_PATH = "/prepare-upgrade";
const GATEWAY_AVATARS_PATH = "/avatars";
const GATEWAY_LOCAL_EXEC_REQUESTS_PATH = "/local-exec-requests";
const GATEWAY_LOCAL_EXEC_RESPONSES_PATH = "/local-exec-responses";
const GATEWAY_WEBAUTHN_REQUESTS_PATH = "/webauthn-requests";
const GATEWAY_WEBAUTHN_RESPONSES_PATH = "/webauthn-responses";
const GATEWAY_COOKIE_ORIGIN_APPROVAL_REQUESTS_PATH = "/cookie-requests";
const GATEWAY_COOKIE_ORIGIN_APPROVAL_RESPONSES_PATH = "/cookie-responses";
function createNodeHttpClient(options2) { return () => { throw Error("unexpected upstream"); }; }
function createCursorChecksum(machine) { return "checksum"; }
function isAuthorized(req, token) { return req.headers.authorization === "Bearer " + token; }
function rejectUntrustedBrowserRequest() { return false; }
function respondError(res, status, message) { res.writeHead(status); res.end(message); }
function respondJson(res, value) { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(value)); }
function createSelectedTeamReader() { return () => null; }
function createHostAuthService(opts) {
  return {
    getGrokBotToken() { throw Error("must not request a token"); },
    getMachineId() { return "a".repeat(32); },
    dispose() {},
    peekAccessToken() { return null; },
    getAccessToken() { return null; }
  };
}
async function handleRequest(deps, req, res, eventStreamEchoes) {
  const url2 = new URL(req.url ?? "/", "http://127.0.0.1");
  if (rejectUntrustedBrowserRequest(deps, req, res)) return;
  if (req.method === "GET" && url2.pathname === GATEWAY_HEALTH_PATH) {
    return respondJson(res, { ok: true, pid: process.pid, isBusy: false });
  }
  const isEvents = req.method === "GET" && url2.pathname === GATEWAY_EVENTS_PATH;
  const isEventsEcho = req.method === "POST" && url2.pathname === GATEWAY_EVENTS_ECHO_PATH;
  const isPrepareUpgrade = req.method === "POST" && url2.pathname === GATEWAY_PREPARE_UPGRADE_PATH;
  const isAvatar = req.method === "GET" && url2.pathname.startsWith(`${GATEWAY_AVATARS_PATH}/`);
  const isLocalExecRequests = req.method === "GET" && url2.pathname === GATEWAY_LOCAL_EXEC_REQUESTS_PATH;
  const isLocalExecResponses = req.method === "POST" && url2.pathname === GATEWAY_LOCAL_EXEC_RESPONSES_PATH;
  const isWebAuthnRequests = req.method === "GET" && url2.pathname === GATEWAY_WEBAUTHN_REQUESTS_PATH;
  const isWebAuthnResponses = req.method === "POST" && url2.pathname === GATEWAY_WEBAUTHN_RESPONSES_PATH;
  const isCookieOriginApprovalRequests = req.method === "GET" && url2.pathname === GATEWAY_COOKIE_ORIGIN_APPROVAL_REQUESTS_PATH;
  const isCookieOriginApprovalResponses = req.method === "POST" && url2.pathname === GATEWAY_COOKIE_ORIGIN_APPROVAL_RESPONSES_PATH;
  const isCommand = req.method === "POST" && url2.pathname.startsWith(`${GATEWAY_API_PREFIX}/`);
  if (isEvents || isEventsEcho || isAvatar || isCommand || isPrepareUpgrade || isLocalExecRequests || isLocalExecResponses || isWebAuthnRequests || isWebAuthnResponses || isCookieOriginApprovalRequests || isCookieOriginApprovalResponses) {
    if ((isLocalExecRequests || isLocalExecResponses) && deps.authToken == null) {
      return respondError(res, 401, "local-exec requires gateway authentication");
    }
    if (deps.authToken != null && !isAuthorized(req, deps.authToken)) {
      return respondError(res, 401, "unauthorized");
    }
    if (isPrepareUpgrade) {
      const result = deps.prepareForUpgrade != null ? await deps.prepareForUpgrade() : { quiescing: false, runningTurns: 0 };
      return respondJson(res, result);
    }
  }
  return respondError(res, 404, "not found");
}
function initialize(context2) {
    const backend = {backendUrl:"https://api2.cursor.sh",clientVersion:"0.44.0",boxNamespace:"prod"};
    const service = createHostAuthService({
      backend,
      log: (message) => context2.host.log(message),
      credentials: context2.host.environment.auth
    });
    context2.onStop(() => service.dispose());
    const getTeamId = createSelectedTeamReader({
      backend,
      peekAccessToken: () => service.peekAccessToken(),
    });
}
module.exports = {handleRequest,initialize};
