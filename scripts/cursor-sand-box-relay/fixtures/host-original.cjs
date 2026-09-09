"use strict";
const GATEWAY_API_PREFIX = "/api";
const GATEWAY_COOKIE_ORIGIN_APPROVAL_REQUESTS_PATH = "/cookie-requests";
const GATEWAY_COOKIE_ORIGIN_APPROVAL_RESPONSES_PATH = "/cookie-responses";
function createNodeHttpClient(options2) { return () => { throw Error("unexpected upstream"); }; }
function createCursorChecksum(machine) { return "checksum"; }
function isAuthorized(req, token) { return req.headers.authorization === "Bearer " + token; }
function rejectUntrustedBrowserRequest() { return false; }
function respondError(res, status, message) { res.writeHead(status); res.end(message); }
function respondJson(res, value) { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(value)); }
function createSelectedTeamReader() { return () => null; }
async function handleRequest(deps, req, res) {
  const url2 = new URL(req.url ?? "/", "http://127.0.0.1");
  if (rejectUntrustedBrowserRequest(deps, req, res)) return;
  const isEvents = false, isAvatar = false, isPrepareUpgrade = false;
  const isLocalExecRequests = false, isLocalExecResponses = false, isWebAuthnRequests = false, isWebAuthnResponses = false;
  const isCookieOriginApprovalRequests = req.method === "GET" && url2.pathname === GATEWAY_COOKIE_ORIGIN_APPROVAL_REQUESTS_PATH;
  const isCookieOriginApprovalResponses = req.method === "POST" && url2.pathname === GATEWAY_COOKIE_ORIGIN_APPROVAL_RESPONSES_PATH;
  const isCommand = req.method === "POST" && url2.pathname.startsWith(`${GATEWAY_API_PREFIX}/`);
  if (isEvents || isAvatar || isCommand || isPrepareUpgrade || isLocalExecRequests || isLocalExecResponses || isWebAuthnRequests || isWebAuthnResponses || isCookieOriginApprovalRequests || isCookieOriginApprovalResponses) {
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
    const service = Object.assign({getGrokBotToken(){throw Error("must not request a token")},getMachineId(){return "a".repeat(32)},dispose(){}}, {
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
