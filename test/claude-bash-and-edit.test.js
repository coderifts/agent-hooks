/**
 * Two holes measured 2026-09-27, held here before the fix.
 *
 * (1) Bash. The matcher was Write|Edit|MultiEdit, so `sed -i … openapi.yaml`, `cat > …`, `tee …`
 *     rewrote a contract with no hook running (anthropics/claude-code #31292 is the same bypass
 *     against a Write deny rule). The hook does not parse shell to gate it — it cannot see the after
 *     bytes — so a shell command that NAMES a recognised contract file AND has a write shape is
 *     denied with a pointer to Write/Edit, where the gate does see the change. A read passes.
 *     Deny, not ask: a hook "ask" was reported to override a settings deny rule (#39344), and an
 *     escalation that can downgrade someone else's deny is not an escalation.
 *     0.3.0 (2026-10-03): the named write stays a deny. A write that can reach a contract without
 *     naming it now asks (contract-write); measured on 2.1.288, a settings deny rule held over a
 *     hook "ask" and over an "allow", so the ask downgrades nothing.
 * (2) Edit. `new_string` is a fragment, not the file. Sending it as the after body made every
 *     one-line Edit look like "everything else was removed". The after body is now the file with
 *     the replacement applied; a MultiEdit applies its edits in order; an edit whose old_string is
 *     not in the file is never guessed (exit 2, as every unreadable change already was).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runClaudeHook } from "../claude-code/hook.mjs";

const OPENAPI = "openapi: 3.0.0\ninfo: {title: T, version: 1.0.0}\npaths:\n  /users: {}\n  /orders: {}\n";

const bash = (command) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

function recorder(reply = { kind: "ok", body: { execution_action: "CONTINUE" } }) {
  const calls = [];
  return {
    calls,
    deps: { askCodeRifts: async (a) => { calls.push(a); return reply; }, readFile: async () => OPENAPI },
  };
}
const decision = (out) => (out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null);

describe("Bash that writes a recognised contract file", () => {
  const WRITES = [
    "cat > api/openapi.yaml <<'EOF'\nopenapi: 3.0.0\nEOF",
    "sed -i '' 's#/orders#/order#' api/openapi.yaml",
    "sed -i.bak -e 's/a/b/' openapi.json",
    "echo 'type Q { a: Int }' >> schema.graphql",
    "printf x | tee proto/user.proto",
    "python3 -c \"open('asyncapi.yaml','w').write('x')\"",
    "perl -pi -e 's/a/b/' swagger.json",
    "mv new.yaml openapi.yaml",
    "cp /tmp/x.json mcp.json",
    "rm api/openapi.yaml",
    "git checkout -- api/openapi.yaml",
    "cd api && sed -i 's/a/b/' ./openapi.yml",
  ];
  for (const cmd of WRITES) {
    it(`deny: ${cmd.split("\n")[0]}`, async () => {
      const r = recorder();
      const out = await runClaudeHook(bash(cmd), { deps: r.deps });
      assert.equal(out.exitCode, 0);
      const d = decision(out);
      assert.equal(d?.permissionDecision, "deny", out.stdout || out.stderr);
      assert.match(d.permissionDecisionReason, /Write or Edit tool/);
      assert.match(d.permissionDecisionReason, /Does not prove/);
      assert.equal(r.calls.length, 0, "a shell write is not sent to CodeRifts: the after bytes are not known");
    });
  }

  const PASSES = [
    "cat api/openapi.yaml",
    "git diff api/openapi.yaml",
    "npx oasdiff breaking old/openapi.yaml api/openapi.yaml",
    "grep -n orders openapi.yaml 2>&1",
    "echo hi > README.md",
    "sed -i 's/a/b/' src/index.js",
    "ls",
  ];
  for (const cmd of PASSES) {
    it(`pass: ${cmd}`, async () => {
      const out = await runClaudeHook(bash(cmd), { deps: recorder().deps });
      assert.equal(out.exitCode, 0);
      assert.equal(out.stdout, "");
    });
  }

  it("the shipped matchers include Bash", () => {
    for (const f of ["hooks/hooks.json", "claude-code/settings.snippet.json"]) {
      const m = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url))).hooks.PreToolUse[0].matcher;
      assert.ok(m.split("|").includes("Bash"), `${f} matcher is ${m}`);
    }
  });
});

describe("Edit and MultiEdit send the whole file after the change", () => {
  const edit = (tool_input, tool_name = "Edit") =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });

  it("Edit: after = before with old_string replaced once", async () => {
    const r = recorder();
    await runClaudeHook(edit({ file_path: "/p/openapi.yaml", old_string: "  /orders: {}\n", new_string: "" }), { deps: r.deps });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].artifact.before, OPENAPI);
    assert.equal(r.calls[0].artifact.after, OPENAPI.replace("  /orders: {}\n", ""));
  });

  it("Edit with replace_all replaces every occurrence", async () => {
    const r = recorder();
    await runClaudeHook(edit({ file_path: "/p/openapi.yaml", old_string: "{}", new_string: "{get: {}}", replace_all: true }), { deps: r.deps });
    assert.equal(r.calls[0].artifact.after, OPENAPI.split("{}").join("{get: {}}"));
  });

  it("MultiEdit applies its edits in order", async () => {
    const r = recorder();
    await runClaudeHook(edit({ file_path: "/p/openapi.yaml", edits: [
      { old_string: "/users", new_string: "/people" },
      { old_string: "/people", new_string: "/persons" },
    ] }, "MultiEdit"), { deps: r.deps });
    assert.equal(r.calls[0].artifact.after, OPENAPI.replace("/users", "/persons"));
  });

  it("an old_string the file does not contain is not guessed: exit 2, nothing sent", async () => {
    const r = recorder();
    const out = await runClaudeHook(edit({ file_path: "/p/openapi.yaml", old_string: "nope", new_string: "x" }), { deps: r.deps });
    assert.equal(r.calls.length, 0);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /does not apply/);
  });
});
