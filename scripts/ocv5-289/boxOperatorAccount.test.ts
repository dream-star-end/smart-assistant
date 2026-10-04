import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBoxOperatorAccount, requireBoxOperatorAccount } from "./boxOperatorAccount.js";

test("any canonical account id is accepted, not only the first Box account", () => {
  assert.deepEqual(parseBoxOperatorAccount("20"), { id: 20n, text: "20" });
  assert.deepEqual(parseBoxOperatorAccount("25"), { id: 25n, text: "25" });
  assert.deepEqual(requireBoxOperatorAccount("ACK", { OCV5_289_ACK_ACCOUNT_ID: "25" }),
    { id: 25n, text: "25" });
  const widest = "9".repeat(19);
  assert.deepEqual(parseBoxOperatorAccount(widest), { id: BigInt(widest), text: widest });
});

test("missing or non-canonical ids never fall back to a default account", () => {
  for (const raw of [undefined, "", "0", "020", "+20", " 20", "20 ", "20n", "2e1", "-1",
    "1".repeat(20)]) {
    assert.equal(parseBoxOperatorAccount(raw), null);
  }
  assert.throws(() => requireBoxOperatorAccount("BOX_STATE_ACK_REQUIRED", {}),
    { message: "BOX_STATE_ACK_REQUIRED" });
  assert.throws(() => requireBoxOperatorAccount("BOX_STATE_ACK_REQUIRED",
    { OCV5_289_ACK_ACCOUNT_ID: "secret-looking-value" }),
  (error: Error) => error.message === "BOX_STATE_ACK_REQUIRED");
});
