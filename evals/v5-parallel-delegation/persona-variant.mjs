#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
};

const BASE = requiredEnv("V5_EVAL_BASE").replace(/\/$/, "");
const EMAIL = requiredEnv("V5_EVAL_EMAIL");
const PASSWORD = readFileSync(requiredEnv("V5_EVAL_PASSWORD_FILE"), "utf8").trim();
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
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, turnstile_token: "x" }),
  });
  if (!response.ok) throw new Error(`login failed ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("login response missing access token");
  return body.access_token;
}

async function requestPersona(token, method, text) {
  const response = await fetch(`${BASE}/api/agents/main/persona`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(text === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
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
const token = await login();
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
  const expectedCurrent = operation === "apply" ? base : candidate(base, rule);
  if (sha(current.text) !== sha(expectedCurrent)) {
    throw new Error(
      `refusing ${operation}: current persona SHA ${sha(current.text)} != expected ${sha(expectedCurrent)}`,
    );
  }
  const next = operation === "apply" ? candidate(base, rule) : base;
  await requestPersona(token, "PUT", next);
  const verified = await requestPersona(token, "GET");
  if (sha(verified.text) !== sha(next)) throw new Error(`${operation} verification SHA mismatch`);
  console.log(JSON.stringify({
    operation,
    persona_rev: sha(next),
    persona_base_rev: sha(base),
    rule_rev: sha(rule.trim()),
    path: verified.path,
  }));
}
