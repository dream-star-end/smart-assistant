/** PreToolUse allowlist. Only the three tuples in the allow file pass. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function decide(event, allow) {
  const name = event && typeof event.tool_name === "string" ? event.tool_name : "";
  const input = event && event.tool_input && typeof event.tool_input === "object"
    ? event.tool_input : null;
  const tuples = allow && Array.isArray(allow.tuples) ? allow.tuples : [];
  const match = input !== null && tuples.some((tuple) => tuple
    && tuple.name === name && canonical(tuple.input) === canonical(input));
  return match ? "allow" : "deny";
}

function response(decision) {
  const output = {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
  };
  if (decision === "deny") output.permissionDecisionReason = "not one of the three fixed tuples";
  return { hookSpecificOutput: output };
}

async function main() {
  const { readFileSync } = await import("node:fs");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  let event = {};
  try {
    const raw = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
    event = raw ? JSON.parse(raw) : {};
  } catch {
    event = {};
  }
  let allow = { tuples: [] };
  try { allow = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")); }
  catch { allow = { tuples: [] }; }
  const decision = decide(event, allow);
  if (process.argv[3]) {
    const { appendFileSync } = await import("node:fs");
    const input = event && event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    appendFileSync(process.argv[3], `${JSON.stringify({
      decision, name: event && event.tool_name, keys: Object.keys(input).sort(),
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify(response(decision))}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("readEditGuard.mjs") && process.argv[2]) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(response("deny"))}\n`);
  });
}
