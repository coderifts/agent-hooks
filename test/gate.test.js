/**
 * The gate, exercised through its own decision surface.
 *
 * The three OpenClaw return shapes were measured against the host's real hook runner before these
 * were written (openclaw 2026.6.35): `undefined` passes, `{block, blockReason}` refuses,
 * `{requireApproval}` asks. What these tests pin is the mapping — and, above all, that NO path
 * reaches `undefined` except a genuine CONTINUE or a call this gate never claimed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGate, decide, classifyPath, DOES_NOT_PROVE } from "../gate.js";

const OPENAPI = 'openapi: 3.0.0\ninfo: {title: T, version: 1.0.0}\npaths:\n  /users: {}\n';
const WRITE = { toolName: "write_file", params: { path: "api/openapi.yaml", content: OPENAPI } };

const gateWith = (reply, cfg = {}) =>
  createGate({ apiKey: "k", ...cfg }, { askCodeRifts: async () => reply, readFile: async () => OPENAPI });

const ok = (body) => ({ kind: "ok", body });

describe("the three shapes", () => {
  it("CONTINUE passes — and passing means undefined, not an empty object", async () => {
    const out = await gateWith(ok({ execution_action: "CONTINUE" }))(WRITE);
    assert.equal(out, undefined);
  });

  it("CONTINUE_WITH_MONITORING also passes — monitoring is not a gate", async () => {
    assert.equal(await gateWith(ok({ execution_action: "CONTINUE_WITH_MONITORING" }))(WRITE), undefined);
  });

  it("STOP blocks, and the reason carries what the answer does NOT prove", async () => {
    const out = await gateWith(ok({ execution_action: "STOP", patterns: ["ENDPOINT_REMOVAL"] }))(WRITE);
    assert.equal(out.block, true);
    assert.match(out.blockReason, /refused this contract change/);
    // The whole point of the field. A refusal an agent cannot bound is a policy engine's DENIED.
    for (const line of DOES_NOT_PROVE) assert.ok(out.blockReason.includes(line), `missing limit: ${line}`);
    assert.match(out.blockReason, /was refused by CodeRifts/);
  });

  it("REQUEST_APPROVAL asks — and does not claim the change was refused", async () => {
    const out = await gateWith(ok({ execution_action: "REQUEST_APPROVAL", risk_score: 42 }))(WRITE);
    assert.ok(out.requireApproval);
    assert.equal(out.requireApproval.timeoutBehavior, "deny");
    assert.match(out.requireApproval.description, /put to a human/);
    assert.ok(!/was refused by CodeRifts/.test(out.requireApproval.description),
      "an approval request must not describe itself as a refusal");
    for (const line of DOES_NOT_PROVE) assert.ok(out.requireApproval.description.includes(line));
  });
});

describe("fail-closed — not knowing is not permission", () => {
  const cases = [
    ["unreachable", { kind: "unreachable", detail: "no answer within 5000ms" }, /could not be reached/],
    ["unreadable answer", { kind: "unusable", detail: "response was not JSON" }, /cannot interpret/],
    ["unknown action", ok({ execution_action: "MAYBE" }), /unrecognised action is not a pass/],
    ["no action at all", ok({}), /unrecognised action is not a pass/],
    ["analyze mode (no key)", ok({ authorization_effect: "NONE", may_execute: false, risk_score: 14 }),
      /answers in analyze mode \(authorization_effect=NONE, may_execute=false\)/],
  ];

  for (const [label, reply, expected] of cases) {
    it(`${label} -> requireApproval with a named reason`, async () => {
      const out = await gateWith(reply, label.includes("no key") ? { apiKey: undefined } : {})(WRITE);
      assert.ok(out?.requireApproval, `${label} must not pass`);
      assert.notEqual(out, undefined);
      assert.ok(!out.block, `${label} is not a refusal — a human still decides`);
      assert.match(out.requireApproval.description, expected);
      assert.equal(out.requireApproval.timeoutBehavior, "deny");
    });
  }

  it("the analyze risk number is never turned into a verdict", async () => {
    // The one thing this plugin must not become. A high risk score in analyze mode still asks;
    // it does not block, because the gate does not own that judgement.
    const out = await gateWith(ok({ authorization_effect: "NONE", may_execute: false, risk_score: 99 }),
      { apiKey: undefined })(WRITE);
    assert.ok(out.requireApproval);
    assert.ok(!out.block, "the gate must not manufacture a block from a risk number");
  });
});

describe("what it does not claim", () => {
  it("NEGATIVE — a non-contract file is not touched, whatever CodeRifts would have said", async () => {
    const out = await gateWith(ok({ execution_action: "STOP" }))({
      toolName: "write_file", params: { path: "README.md", content: "hi" },
    });
    assert.equal(out, undefined);
  });

  it("a recognised artifact whose content it cannot find is asked about, not waved through", async () => {
    const out = await gateWith(ok({ execution_action: "CONTINUE" }))({
      toolName: "some_unknown_tool", params: {}, derivedPaths: ["api/openapi.yaml"],
    });
    assert.ok(out.requireApproval);
    assert.match(out.requireApproval.description, /will not pass a change it has not seen/);
  });

  it("classifies only what it lists", () => {
    assert.equal(classifyPath("api/openapi.yaml"), "openapi");
    assert.equal(classifyPath("schema.graphql"), "graphql");
    assert.equal(classifyPath("svc.proto"), "protobuf");
    assert.equal(classifyPath("docs/openapi-guide.md"), null);
    assert.equal(classifyPath("README.md"), null);
  });

  it("decide() has no default pass — every unrecognised outcome asks", () => {
    for (const body of [{}, { execution_action: null }, { execution_action: "" }, { decision: "ALLOW" }]) {
      const out = decide(ok(body), { operation: "tool_call", path: "api/openapi.yaml" });
      assert.notEqual(out, undefined, `${JSON.stringify(body)} must not pass`);
    }
  });
});
