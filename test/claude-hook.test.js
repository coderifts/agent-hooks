/**
 * Claude Code PreToolUse adapter. Fixtures use the host's real stdin shape
 * (tool_name + tool_input), not the OpenClaw event.
 *
 * Four mappings (measured 2026-09-13):
 *   CONTINUE            → exit 0, empty stdout (never permissionDecision allow)
 *   REQUEST_APPROVAL    → JSON ask
 *   STOP                → JSON deny (reason carries Does not prove)
 *   error (unreachable, bad stdin, throw) → exit 2 + stderr
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runClaudeHook } from "../claude-code/hook.mjs";

const OPENAPI = "openapi: 3.0.0\ninfo: {title: T, version: 1.0.0}\npaths:\n  /users: {}\n";

const write = (path, content) =>
  JSON.stringify({
    session_id: "s",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: path, content },
    tool_use_id: "toolu_test",
  });

const gateWith = (reply) => ({
  askCodeRifts: async () => reply,
  readFile: async () => OPENAPI,
});

const ok = (body) => ({ kind: "ok", body });

function parseStdout(out) {
  if (!out.stdout) return null;
  return JSON.parse(out.stdout);
}

describe("Claude Code adapter mappings", () => {
  it("CONTINUE → exit 0, empty stdout — never allow", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      { deps: gateWith(ok({ execution_action: "CONTINUE" })) },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
    assert.equal(out.stderr, "");
    assert.ok(!/allow/.test(out.stdout));
  });

  it("a non-contract Write is not gated — exit 0, empty", async () => {
    const out = await runClaudeHook(
      write("/tmp/README.md", "# hi\n"),
      { deps: gateWith(ok({ execution_action: "STOP" })) },
    );
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  it("REQUEST_APPROVAL → permissionDecision ask with a named reason", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      { deps: gateWith(ok({ execution_action: "REQUEST_APPROVAL", risk_score: 42 })) },
    );
    assert.equal(out.exitCode, 0);
    const json = parseStdout(out);
    assert.equal(json.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(json.hookSpecificOutput.permissionDecision, "ask");
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /put to a human/);
    assert.ok(!json.hookSpecificOutput.permissionDecisionReason.includes("was refused by CodeRifts"));
  });

  it("STOP → permissionDecision deny, carrying Does not prove", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      { deps: gateWith(ok({ execution_action: "STOP", patterns: ["ENDPOINT_REMOVAL"] })) },
    );
    assert.equal(out.exitCode, 0);
    const json = parseStdout(out);
    assert.equal(json.hookSpecificOutput.permissionDecision, "deny");
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /refused this contract change/);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /Does not prove/);
    assert.match(json.hookSpecificOutput.permissionDecisionReason, /ENDPOINT_REMOVAL/);
  });

  it("unreachable CodeRifts → exit 2 + stderr (host is fail-open otherwise)", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      { deps: gateWith({ kind: "unreachable", detail: "no answer within 5000ms" }) },
    );
    assert.equal(out.exitCode, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /could not be reached/);
    assert.match(out.stderr, /not knowing is not permission/);
  });

  it("unreadable CodeRifts answer → exit 2 + stderr", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      { deps: gateWith({ kind: "unusable", detail: "response was not JSON" }) },
    );
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /cannot interpret/);
  });

  it("invalid stdin JSON → exit 2 + stderr", async () => {
    const out = await runClaudeHook("not-json", { deps: gateWith(ok({ execution_action: "CONTINUE" })) });
    assert.equal(out.exitCode, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /stdin/);
  });

  it("a thrown gate → exit 2 + stderr, never an empty pass", async () => {
    const out = await runClaudeHook(
      write("/tmp/api/openapi.yaml", OPENAPI),
      {
        deps: {
          askCodeRifts: async () => {
            throw new Error("boom");
          },
          readFile: async () => OPENAPI,
        },
      },
    );
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /boom/);
  });

  it("Edit of a contract file uses new_string as the proposed body", async () => {
    const stdin = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/tmp/api/openapi.yaml",
        old_string: "paths: {}",
        new_string: OPENAPI,
      },
    });
    const out = await runClaudeHook(stdin, {
      deps: gateWith(ok({ execution_action: "CONTINUE" })),
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });
});
