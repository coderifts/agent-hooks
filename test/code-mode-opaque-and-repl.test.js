/**
 * Code Mode shapes measured before the fix (round 10ar), in this file's harness:
 * git push, `cd 'app' && git push`, and `cd app; git push` passed.
 * `sh -c 'git push origin main'` passed. `eval "git push origin main"` asked when the
 * working tree held a contract file and passed when it did not.
 * REPL passed for both a $`…` shell template and edit() of a contract path.
 * A named write hidden behind &&, ;, a newline, ||, or a pipe already denied.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runClaudeHook } from "../claude-code/hook.mjs";

const OPENAPI = "openapi: 3.0.0\ninfo: {title: T, version: 1.0.0}\npaths:\n  /users: {}\n";

const event = (tool_name, tool_input) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input });

function recorder() {
  const calls = [];
  return {
    calls,
    deps: {
      askCodeRifts: async (a) => {
        calls.push(a);
        return { kind: "ok", body: { execution_action: "CONTINUE" } };
      },
      readFile: async () => OPENAPI,
      listDir: async () => [],
    },
  };
}

const decision = (out) => (out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null);

async function bash(command, deps = recorder().deps) {
  const out = await runClaudeHook(event("Bash", { command }), { deps });
  return { out, d: decision(out) };
}

describe("Bash segments and unchecked shell shapes", () => {
  it("git push origin main passes", async () => {
    const { out, d } = await bash("git push origin main");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
    assert.equal(d, null);
  });

  it("cd 'app' && git push origin main passes, the same decision as git push", async () => {
    const { out } = await bash("cd 'app' && git push origin main");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  it("cd app; git push origin main passes", async () => {
    const { out } = await bash("cd app; git push origin main");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  for (const command of [
    "sh -c 'git push origin main'",
    "bash -c 'git push origin main'",
    'eval "git push origin main"',
    "$(git push origin main)",
    "`git push origin main`",
    "base64 -d | sh",
    "echo eA== | base64 -d | bash",
    "echo hi && sh -c 'git push origin main'",
  ]) {
    it(`denies an unchecked shape: ${command}`, async () => {
      const r = recorder();
      const { out, d } = await bash(command, r.deps);
      assert.equal(out.exitCode, 0);
      assert.equal(d?.permissionDecision, "deny", out.stdout || out.stderr);
      assert.match(d.permissionDecisionReason, /cannot read this shell shape/);
      assert.equal(r.calls.length, 0);
    });
  }

  it("a named contract write inside sh -c keeps the Write or Edit denial", async () => {
    const { out, d } = await bash("sh -c \"sed -i '' 's/a/b/' openapi.yaml\"");
    assert.equal(out.exitCode, 0);
    assert.equal(d?.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /Write or Edit tool/);
    assert.match(d.permissionDecisionReason, /Does not prove/);
  });

  it("git push && sed -i of a contract file stays a named denial", async () => {
    const { out, d } = await bash("git push origin main && sed -i '' 's/a/b/' openapi.yaml");
    assert.equal(out.exitCode, 0);
    assert.equal(d?.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /Write or Edit tool/);
    assert.match(d.permissionDecisionReason, /Does not prove/);
  });
});

describe("REPL text in tool_input.code", () => {
  const repl = (code) => event("REPL", { code });

  it("denies a $`git push origin main` shell template", async () => {
    const r = recorder();
    const out = await runClaudeHook(repl("$`git push origin main`"), { deps: r.deps });
    const d = decision(out);
    assert.equal(out.exitCode, 0);
    assert.equal(d?.permissionDecision, "deny", out.stdout || out.stderr);
    assert.match(d.permissionDecisionReason, /does not see values computed at run time/);
    assert.equal(r.calls.length, 0);
  });

  it("denies edit() whose text names a contract path", async () => {
    const r = recorder();
    const code = "edit({ file_path: 'api/openapi.yaml', old_string: 'a', new_string: 'b' })";
    const out = await runClaudeHook(repl(code), { deps: r.deps });
    const d = decision(out);
    assert.equal(out.exitCode, 0);
    assert.equal(d?.permissionDecision, "deny", out.stdout || out.stderr);
    assert.match(d.permissionDecisionReason, /api\/openapi\.yaml/);
    assert.match(d.permissionDecisionReason, /does not see values computed at run time/);
    assert.equal(r.calls.length, 0);
  });

  it("passes edit() of a path that is not a contract file", async () => {
    const out = await runClaudeHook(repl("edit({ file_path: 'src/index.js', old_string: 'a', new_string: 'b' })"), { deps: recorder().deps });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  it("passes a template literal that is not a shell template", async () => {
    const out = await runClaudeHook(repl("const label = `hello`"), { deps: recorder().deps });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  it("passes Bash() of git push written as ordinary JavaScript text", async () => {
    const out = await runClaudeHook(repl("Bash({ command: 'git push origin main' })"), { deps: recorder().deps });
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
  });

  it("the shipped matchers include REPL", () => {
    for (const f of ["hooks/hooks.json", "claude-code/settings.snippet.json"]) {
      const m = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url))).hooks.PreToolUse[0].matcher;
      assert.ok(m.split("|").includes("REPL"), `${f} matcher is ${m}`);
    }
  });
});
