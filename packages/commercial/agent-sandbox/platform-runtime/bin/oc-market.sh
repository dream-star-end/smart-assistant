#!/bin/sh
# oc-market — in-container CLI for AI-driven AI-marketplace operations.
# Thin wrapper → gateway tsx entry (talks to master /internal/v3/marketplace/agent/*
# with the container token). See the `market` baseline skill for usage.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

# Connector publishing lives here rather than packages/gateway so the command can
# ship through the true-hot platform bundle without a runtime image rebuild.
if [ "${1:-}" = "publish-connector" ]; then
  shift
  exec python3 - "$@" <<'PY'
import argparse
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request


def die(message):
    print(f"oc-market: {message}", file=sys.stderr)
    raise SystemExit(1)


def json_object(path, label):
    try:
        value = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        die(f"cannot read {label}: {exc}")
    except json.JSONDecodeError as exc:
        die(f"{label} is not valid JSON: {exc}")
    if not isinstance(value, dict):
        die(f"{label} must contain a JSON object")
    return value


CONNECTOR_EXAMPLES = {
    "static-token": {
        "spec": {
            "id": "example-static-api",
            "label": "Example Static API",
            "description": "Bearer token API connector template.",
            "authMode": "static-token",
            "auth": {"apiCredentialPlacements": [
                {"source": "access_token", "placement": "authorization-bearer"}
            ]},
            "originMode": "fixed-reviewed",
            "credentialPipeline": {"nodes": [
                {"id": "api-token", "authMode": "static-token", "subject": "user", "audience": "api"}
            ]},
            "identity": {
                "probeActionId": "whoami",
                "accountKeyPointer": "/id",
                "accountHintPointer": "/name"
            },
            "actions": [{
                "id": "whoami",
                "description": "Return the authenticated account.",
                "request": {"method": "GET", "pathTemplate": "/v1/me"},
                "params": {"type": "object", "additionalProperties": False},
                "result": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"id": {"type": "string"}, "name": {"type": "string"}}
                },
                "usesSlot": "api-token"
            }]
        },
        "securityDecision": {
            "audience": {
                "authorizationOrigins": [], "tokenOrigins": [],
                "apiOrigins": ["https://api.example.com:443"],
                "unauthenticatedUploadOrigins": []
            },
            "actions": {}
        }
    },
    "token-exchange": {
        "spec": {
            "id": "example-token-exchange",
            "label": "Example Token Exchange",
            "description": "Exchange app credentials for an API token.",
            "authMode": "token-exchange",
            "auth": {
                "exchangeRequest": {
                    "method": "POST", "path": "/oauth/token", "encoding": "json",
                    "credentialFieldNames": {"client_id": "client_id", "client_secret": "client_secret"}
                },
                "tokenResponse": {},
                "tokenOutputs": {"accessToken": "/access_token", "expiresIn": "/expires_in"},
                "apiCredentialPlacements": [
                    {"source": "access_token", "placement": "authorization-bearer"}
                ]
            },
            "originMode": "fixed-reviewed",
            "credentialPipeline": {"nodes": [
                {"id": "exchange", "authMode": "token-exchange", "subject": "app", "audience": "token"},
                {
                    "id": "api-token", "authMode": "token-exchange", "subject": "app",
                    "audience": "api", "dependsOn": ["exchange"]
                }
            ]},
            "identity": {
                "probeActionId": "whoami", "accountKeyPointer": "/id",
                "accountHintPointer": "/name"
            },
            "actions": [{
                "id": "whoami", "description": "Return the application identity.",
                "request": {"method": "GET", "pathTemplate": "/v1/me"},
                "params": {"type": "object", "additionalProperties": False},
                "result": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"id": {"type": "string"}, "name": {"type": "string"}}
                },
                "usesSlot": "api-token"
            }]
        },
        "securityDecision": {
            "audience": {
                "authorizationOrigins": [],
                "tokenOrigins": ["https://auth.example.com:443"],
                "apiOrigins": ["https://api.example.com:443"],
                "unauthenticatedUploadOrigins": []
            },
            "actions": {}
        }
    },
    "oauth2-auth-code-byoa": {
        "spec": {
            "id": "example-oauth2-byoa",
            "label": "Example OAuth2 BYOA",
            "description": "OAuth2 authorization-code connector with a user-owned app.",
            "authMode": "oauth2-auth-code",
            "auth": {
                "authorizeEndpoint": "https://auth.example.com/oauth/authorize",
                "tokenEndpoint": "https://auth.example.com/oauth/token",
                "clientProvisioning": "byoa", "clientAuth": "form", "scopeSeparator": " ",
                "scopes": ["profile.read"], "refreshRotation": True,
                "refreshEncoding": "form", "pkce": "required",
                "tokenOutputs": {
                    "accessToken": "/access_token", "refreshToken": "/refresh_token",
                    "expiresIn": "/expires_in"
                },
                "apiCredentialPlacements": [
                    {"source": "access_token", "placement": "authorization-bearer"}
                ]
            },
            "originMode": "fixed-reviewed",
            "credentialPipeline": {"nodes": [
                {"id": "api-token", "authMode": "oauth2-auth-code", "subject": "user", "audience": "api"}
            ]},
            "identity": {
                "probeActionId": "whoami", "accountKeyPointer": "/id",
                "accountHintPointer": "/name"
            },
            "actions": [{
                "id": "whoami", "description": "Return the authorized user.",
                "request": {"method": "GET", "pathTemplate": "/v1/me"},
                "params": {"type": "object", "additionalProperties": False},
                "result": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"id": {"type": "string"}, "name": {"type": "string"}}
                },
                "usesSlot": "api-token"
            }]
        },
        "securityDecision": {
            "audience": {
                "authorizationOrigins": ["https://auth.example.com:443"],
                "tokenOrigins": ["https://auth.example.com:443"],
                "apiOrigins": ["https://api.example.com:443"],
                "unauthenticatedUploadOrigins": []
            },
            "actions": {}
        }
    }
}


if sys.argv[1:] == ["--examples"]:
    print(json.dumps(CONNECTOR_EXAMPLES, ensure_ascii=False, indent=2))
    raise SystemExit(0)


parser = argparse.ArgumentParser(
    prog="oc-market publish-connector",
    description="Publish a ConnectorSpec and proposed SecurityDecision for AI review.",
    epilog="Run with --examples to print complete validated static-token, token-exchange and OAuth2 BYOA templates.",
)
parser.add_argument("--spec-file", required=True, help="ConnectorSpec JSON object file")
parser.add_argument(
    "--security-decision-file", required=True, help="proposed SecurityDecision JSON object file"
)
parser.add_argument("--version", required=True, help="semantic version, e.g. 1.0.0")
parser.add_argument("--category", required=True, help="marketplace category id")
parser.add_argument(
    "--use-cases", required=True, help="1-4 user scenarios separated by semicolons"
)
parser.add_argument("--outcomes", default="", help="effect examples separated by semicolons")
parser.add_argument("--tags", default="连接器", help="comma-separated tags")
parser.add_argument("--intro-file", help="optional Markdown storefront introduction")
parser.add_argument("--visibility", choices=("public", "org"), default="public")
args = parser.parse_args()

spec = json_object(args.spec_file, "--spec-file")
decision = json_object(args.security_decision_file, "--security-decision-file")

payload = {
    "kind": "connector",
    "version": args.version,
    "spec": spec,
    "securityDecision": decision,
    "category": args.category,
    "useCases": [x.strip() for x in args.use_cases.split(";") if x.strip()],
    "outcomeExamples": [x.strip() for x in args.outcomes.split(";") if x.strip()],
    "tags": [x.strip() for x in args.tags.split(",") if x.strip()],
}
if args.visibility == "org":
    payload["visibility"] = "org"
if args.intro_file:
    try:
        payload["humanMd"] = pathlib.Path(args.intro_file).read_text(encoding="utf-8")
    except OSError as exc:
        die(f"cannot read --intro-file: {exc}")

home = os.environ.get("OPENCLAUDE_HOME", "").strip()
if not home:
    home = str(pathlib.Path(os.environ.get("HOME", str(pathlib.Path.home()))) / ".openclaude")
config_path = pathlib.Path(home) / "openclaude.json"
try:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    port = int(config["gateway"]["port"])
except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
    die(f"cannot resolve local gateway from {config_path}: {exc}")
if port < 1 or port > 65535:
    die(f"invalid local gateway port: {port}")

url = f"http://127.0.0.1:{port}/internal/v3/marketplace/agent-local/publish"
body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
request = urllib.request.Request(
    url,
    data=body,
    method="POST",
    headers={"Content-Type": "application/json", "Accept": "application/json"},
)
try:
    # Never inherit HTTP(S)_PROXY for the identity-bearing loopback relay.
    response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=30)
    raw = response.read().decode("utf-8")
except urllib.error.HTTPError as exc:
    detail = exc.read().decode("utf-8", errors="replace")
    die(f"publish failed: HTTP {exc.code}: {detail}")
except (urllib.error.URLError, TimeoutError, OSError) as exc:
    die(f"publish relay failed: {exc}")
try:
    result = json.loads(raw) if raw else {}
except json.JSONDecodeError:
    die(f"publish relay returned invalid JSON: {raw[:400]}")
print(json.dumps(result, ensure_ascii=False, indent=2))
PY
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocMarketCli.ts "$@"
