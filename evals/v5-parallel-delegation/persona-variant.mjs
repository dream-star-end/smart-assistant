#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  authorizedFetch,
  loginAuthSession,
} from "./auth-session.mjs";

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
};

const BASE = requiredEnv("V5_EVAL_BASE").replace(/\/$/, "");
const EMAIL = requiredEnv("V5_EVAL_EMAIL");
const AUTH_SESSION_FILE = process.env.V5_EVAL_AUTH_SESSION_FILE?.trim() || null;
const PASSWORD = AUTH_SESSION_FILE
  ? null
  : readFileSync(requiredEnv("V5_EVAL_PASSWORD_FILE"), "utf8").trim();
const [operation, ...argv] = process.argv.slice(2);
const args = Object.fromEntries(
  Array.from({ length: Math.ceil(argv.length / 2) }, (_, index) => [
    argv[index * 2]?.replace(/^--/, ""),
    argv[index * 2 + 1],
  ]),
);

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function login() {
  return (await loginAuthSession(BASE, EMAIL, PASSWORD)).access_token;
}

async function requestPersona(token, method, text) {
  const init = {
    method,
    headers: {
      ...(text === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
  };
  const response = AUTH_SESSION_FILE
    ? await authorizedFetch(BASE, AUTH_SESSION_FILE, `${BASE}/api/agents/main/persona`, init)
    : await fetch(`${BASE}/api/agents/main/persona`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
    });
  if (!response.ok) {
    throw new Error(`persona ${method} failed ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

function candidate(base, rule) {
  return `${base.replace(/\s+$/, "")}\n\n${rule.trim()}\n`;
}

if (!["snapshot", "apply", "restore"].includes(operation)) {
  throw new Error(
    "usage: persona-variant.mjs snapshot --out <base.txt> | " +
    "apply --base <base.txt> --rule <rule.md> | restore --base <base.txt> --rule <rule.md>",
  );
}
const token = AUTH_SESSION_FILE ? null : await login();
const current = await requestPersona(token, "GET");
if (typeof current.text !== "string") throw new Error("persona GET response missing text");

if (operation === "snapshot") {
  if (!args.out) throw new Error("snapshot requires --out");
  writeFileSync(args.out, current.text, { mode: 0o600 });
  chmodSync(args.out, 0o600);
  console.log(JSON.stringify({ operation, persona_rev: sha(current.text), path: current.path }));
} else {
  if (!args.base || !args.rule) throw new Error(`${operation} requires --base and --rule`);
  const base = readFileSync(args.base, "utf8");
  const rule = readFileSync(args.rule, "utf8");
  const candidateText = candidate(base, rule);
  const expected = operation === "apply"
    ? [base]
    : [base, candidateText];
  if (!expected.some((text) => sha(current.text) === sha(text))) {
    throw new Error(
      `refusing ${operation}: current persona SHA ${sha(current.text)} is not an expected state`,
    );
  }
  const next = operation === "apply" ? candidateText : base;
  if (sha(current.text) !== sha(next)) {
    await requestPersona(token, "PUT", next);
  }
  const verified = sha(current.text) === sha(next)
    ? current
    : await requestPersona(token, "GET");
  if (sha(verified.text) !== sha(next)) throw new Error(`${operation} verification SHA mismatch`);
  console.log(JSON.stringify({
    operation,
    persona_rev: sha(next),
    persona_base_rev: sha(base),
    rule_rev: sha(rule.trim()),
    path: verified.path,
  }));
}
