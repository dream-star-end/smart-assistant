#!/bin/sh
# oc-market — in-container CLI for AI-driven AI-marketplace operations.
# Thin wrapper → gateway tsx entry (talks to master /internal/v3/marketplace/agent/*
# with the container token). See the `market` baseline skill for usage.
set -e
# 单次调用版本自钉(设计 §1.2 R2-M5):readlink -f 穿透 current symlink → rev-pinned bundle 根。
# 本薄壳无 sibling 引用,SELF_ROOT 仅立"工具单文件独立、禁相对 sibling 裸调用"不变量(测试固化)。
SELF_ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
# help-fast-path: stdout usage + exit 0; do not start tsx/node/network.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  cat <<'EOF'
usage: oc-market <search|detail|installed|install|uninstall|publish-skill|publish-agent|plugin|publish-connector> ...
EOF
  exit 0
fi


# Plugin authoring lives here rather than packages/gateway so the command can ship
# through the true-hot platform bundle without a runtime image rebuild. The old
# publish-connector surface retains read-only help/examples but cannot publish.
if [ "${1:-}" = "plugin" ] || [ "${1:-}" = "publish-connector" ]; then
  MARKET_COMMAND="$1"
  shift
  exec python3 - "$MARKET_COMMAND" "$@" <<'PY'
import argparse
import json
import os
import pathlib
import shlex
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


MARKETPLACE_CATEGORIES = [
    "office-docs", "data-analysis", "coding-dev", "research-academic",
    "design-creative", "finance-business", "daily-tools", "skill-pack",
]
PLUGIN_DRAFT_KEYS = {
    "kind", "version", "spec", "securityDecision", "category", "useCases",
    "outcomeExamples", "humanMd", "tags", "visibility",
}


def plugin_examples():
    examples = {}
    for name, connector in CONNECTOR_EXAMPLES.items():
        examples[name] = {
            "kind": "plugin",
            "version": "1.0.0",
            "category": "daily-tools",
            "useCases": ["连接外部服务并读取当前账号信息"],
            "outcomeExamples": ["完成账号授权后，返回当前账号身份"],
            "tags": ["API插件"],
            "visibility": "public",
            "spec": connector["spec"],
            "securityDecision": connector["securityDecision"],
        }
    blueprint = {
        "format": "plugin-blueprint-v1",
        "slug": "example-api",
        "name": "Example API",
        "description": "Read the current account and items from Example API.",
        "category": "daily-tools",
        "useCases": ["连接外部服务并读取当前账号信息"],
        "outcomeExamples": ["完成账号授权后，返回当前账号身份"],
        "tags": ["API插件"],
        "visibility": "public",
        "apiOrigin": "https://api.example.com",
        "auth": {"mode": "static-token"},
        "identity": {
            "actionId": "whoami", "accountKeyPointer": "/id",
            "accountHintPointer": "/name"
        },
        "actions": [{
            "id": "whoami", "description": "Return the authenticated account.",
            "method": "GET", "path": "/v1/me",
            "params": {"type": "object", "properties": {}, "additionalProperties": False},
            "result": {
                "type": "object", "properties": {
                    "id": {"type": "string"}, "name": {"type": "string"}
                }, "additionalProperties": False
            }
        }]
    }
    return {
        "categoryIds": MARKETPLACE_CATEGORIES,
        "recommendedBlueprint": blueprint,
        "advancedRawDrafts": examples,
    }


def plugin_draft(path):
    draft = json_object(path, "--file")
    if draft.get("format") == "plugin-blueprint-v1":
        return draft
    unknown = sorted(set(draft) - PLUGIN_DRAFT_KEYS)
    if unknown:
        die(f"--file has unknown top-level fields: {', '.join(unknown)}")
    if draft.get("kind") != "plugin":
        die("--file kind must be 'plugin'")
    visibility = draft.get("visibility", "public")
    if visibility not in ("public", "org"):
        die("--file visibility must be 'public' or 'org'")
    payload = dict(draft)
    payload["kind"] = "connector"
    if visibility == "public":
        payload.pop("visibility", None)
    return payload


def local_gateway_port():
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
    return port


def relay(payload, operation, action):
    url = (
        f"http://127.0.0.1:{local_gateway_port()}"
        f"/internal/v3/marketplace/agent-local/{operation}"
    )
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        # Never inherit HTTP(S)_PROXY for the identity-bearing loopback relay.
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            request, timeout=30
        )
        raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        die(f"{action} failed: HTTP {exc.code}: {detail}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        die(f"{action} relay failed: {exc}")
    try:
        result = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        die(f"{action} relay returned invalid JSON: {raw[:400]}")
    if not isinstance(result, dict):
        die(f"{action} relay returned a non-object response")
    return result


command = sys.argv[1]
argv = sys.argv[2:]

if command == "plugin":
    parser = argparse.ArgumentParser(
        prog="oc-market plugin",
        description="Prepare and publish compact one-file declarative HTTP Plugin blueprints.",
    )
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("examples", help="print the compact blueprint, advanced drafts and category ids")
    prepare_parser = sub.add_parser("prepare", help="compile and validate without publishing")
    prepare_parser.add_argument("--file", required=True, help="compact blueprint or advanced draft JSON")
    validate_parser = sub.add_parser("validate", help="compatibility alias for prepare")
    validate_parser.add_argument("--file", required=True, help="compact blueprint or advanced draft JSON")
    publish_parser = sub.add_parser("publish", help="publish the exact validated draft")
    publish_parser.add_argument("--file", required=True, help="compact blueprint or advanced draft JSON")
    publish_parser.add_argument(
        "--confirm", required=True, help="validationHash returned by plugin prepare"
    )
    args = parser.parse_args(argv)
    if args.operation == "examples":
        print(json.dumps(plugin_examples(), ensure_ascii=False, indent=2))
        raise SystemExit(0)

    draft = plugin_draft(args.file)
    validated = relay(draft, "prepare-plugin", "preparation")
    validation_hash = validated.get("validationHash")
    if not isinstance(validation_hash, str) or len(validation_hash) != 64:
        die("validation relay omitted a valid validationHash")
    if args.operation in ("prepare", "validate"):
        validated["publishCommand"] = (
            f"oc-market plugin publish --file {shlex.quote(args.file)} "
            f"--confirm {validation_hash}"
        )
        print(json.dumps(validated, ensure_ascii=False, indent=2))
        raise SystemExit(0)
    if args.confirm != validation_hash:
        die("draft changed or confirmation hash is stale; validate again and ask the user to reconfirm")
    print(json.dumps(relay({
        "draft": draft, "confirmationHash": args.confirm
    }, "publish-plugin", "publish"), ensure_ascii=False, indent=2))
    raise SystemExit(0)

if argv == ["--examples"]:
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
args = parser.parse_args(argv)

die(
    "legacy publish-connector is disabled; use `oc-market plugin prepare --file ...`, "
    "show the returned summary to the user, then run its confirmed publishCommand"
)

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
print(json.dumps(relay(payload, "publish", "publish"), ensure_ascii=False, indent=2))
PY
fi

cd /opt/openclaude
exec npx --no-install tsx packages/gateway/src/ocMarketCli.ts "$@"
