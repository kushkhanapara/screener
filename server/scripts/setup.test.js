import { test } from "node:test";
import assert from "node:assert/strict";
import { envWithToken, nodeIsNewEnough, mask } from "./setup.js";

test("the token replaces the blank line and leaves the rest alone", () => {
  const before = "# comment\nUPSTOX_ANALYTICS_TOKEN=\nPORT=8080\n";
  const after = envWithToken(before, "abc123");
  assert.equal(after, "# comment\nUPSTOX_ANALYTICS_TOKEN=abc123\nPORT=8080\n");
});

test("a missing line is added, and an existing token is replaced", () => {
  assert.match(envWithToken("PORT=8080\n", "xyz"), /^PORT=8080\nUPSTOX_ANALYTICS_TOKEN=xyz\n$/);
  assert.equal(envWithToken("UPSTOX_ANALYTICS_TOKEN=old\n", "new"), "UPSTOX_ANALYTICS_TOKEN=new\n");
});

test("Node version check", () => {
  assert.equal(nodeIsNewEnough("v22.5.0"), true);
  assert.equal(nodeIsNewEnough("v24.12.0"), true);
  assert.equal(nodeIsNewEnough("v22.4.1"), false);
  assert.equal(nodeIsNewEnough("v20.11.0"), false);
});

test("a token is never shown in full", () => {
  const token = "abcdefghijklmnop";
  const shown = mask(token);
  assert.ok(!shown.includes(token));
  assert.ok(shown.startsWith("abcd") && shown.includes("mnop"));
});
