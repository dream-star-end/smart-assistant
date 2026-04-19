import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stubMailer } from "../auth/mail.js";

describe("auth.mail.stubMailer", () => {
  test("writes a single line with [mail-stub] prefix to stdout", async () => {
    const original = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    (process.stdout as { write: typeof process.stdout.write }).write = ((
      chunk: string | Uint8Array,
    ): boolean => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      await stubMailer.send({
        to: "u@example.com",
        subject: "hi",
        text: "verify-url-here",
      });
    } finally {
      (process.stdout as { write: typeof process.stdout.write }).write = original;
    }

    assert.equal(captured.length, 1);
    const line = captured[0];
    assert.match(line, /^\[mail-stub\] /);
    assert.ok(line.endsWith("\n"));
    const json = JSON.parse(line.slice("[mail-stub] ".length).trimEnd());
    assert.equal(json._kind, "mail-stub");
    assert.equal(json.to, "u@example.com");
    assert.equal(json.subject, "hi");
    assert.equal(json.text, "verify-url-here");
    assert.match(json.ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});
