/**
 * Claude Code PreToolUse adapter. Translates the host's stdin JSON into the
 * OpenClaw-shaped event `createGate` already understands, then maps the three
 * gate results onto the Claude Code contract (measured 2026-09-13):
 *
 *   undefined           → exit 0, empty stdout (NOT permissionDecision allow)
 *   requireApproval     → JSON ask  (named CodeRifts decision)
 *   block               → JSON deny (reason includes Does not prove)
 *   transport/parse/throw → exit 2 + stderr  (the host is fail-open otherwise)
 *
 * Which call touches a contract file is decided by contract-write.mjs, the one decision function
 * `coderifts claude-hook` and the CodeRifts mod run too (0.3.0, 2026-10-03):
 *   - Edit/MultiEdit carry an edit, not a body; the after file is the one on disk with it applied.
 *   - Bash is not gated (the after bytes are unknown). A command that writes a named contract file
 *     is denied with a pointer to Write/Edit, where the gate does see it; one that can write a
 *     directory holding a contract without naming it (find -exec, xargs, a glob, a tree-wide git
 *     restore, an interpreter, a pipe into sh) asks.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterText, decideToolCall } from "../contract-write.mjs";
import { createGate, DOES_NOT_PROVE, hostIo } from "../gate.js";

/** The file after an Edit (`params` is the edit) or a MultiEdit (`params.edits`, in order): contract-write's afterText. */
export function applyEdits(params, before) {
  return afterText(Array.isArray(params.edits) ? "MultiEdit" : "Edit", params, before);
}

/** Claude Code Write/Edit/MultiEdit → the path/content keys `resolveTarget` reads. */
export const CLAUDE_TOOL_SHAPES = Object.freeze({
  Write: { path: "file_path", content: "content" },
  Edit: { path: "file_path", apply: applyEdits },
  MultiEdit: { path: "file_path", apply: applyEdits },
});

const SHELL_DOES_NOT_PROVE = [
  "that a contract file written by a shell command this hook did not recognise was seen at all",
  ...DOES_NOT_PROVE.slice(1),
];

/** contract-write's Bash decision as this hook's text: refusal or ask, each with what it proves. */
export async function shellDecision(command, io) {
  const d = await decideToolCall({ tool: "Bash", input: { command } }, io);
  if (d.action === "pass") return null;
  const named = d.action === "refuse";
  const lines = [
    named
      ? `CodeRifts cannot see a contract change made by a shell command (${d.paths.map((p) => p.path).join(", ")}).`
      : `CodeRifts cannot see what this shell command writes under ${d.scopes.map((s) => (s === "." ? "the working tree" : s)).join(", ")}, and a contract file is there.`,
    named
      ? `Use the Write or Edit tool for contract files, so the change is checked before it lands.`
      : `Use the Write or Edit tool for contract files, or confirm that this command leaves them alone.`,
    named
      ? `Proves: only that this command names a recognised contract file with a write shape.`
      : `Proves: only that this command has a write shape (${d.by.join(", ")}) that can reach a contract file without naming it.`,
    `Does not prove:`,
    ...SHELL_DOES_NOT_PROVE.map((l) => `  - ${l}`),
  ];
  return { decision: named ? "deny" : "ask", text: lines.join("\n") };
}

/** Kept for 0.2.x callers: the refusal text for a command, or null (named writes only). */
export async function shellContractWrite(command, io = hostIo(process.cwd())) {
  const r = await shellDecision(command, io);
  return r && r.decision === "deny" ? r.text : null;
}

const ASK_TITLES = new Set([
  "CodeRifts asks for approval",
  "CodeRifts returned analysis, not authorization",
]);

function emptyPass() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function jsonDecision(permissionDecision, reason) {
  return {
    exitCode: 0,
    stdout:
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision,
          permissionDecisionReason: reason,
        },
      }) + "\n",
    stderr: "",
  };
}

function failClosed(message) {
  return { exitCode: 2, stdout: "", stderr: String(message).trim() + "\n" };
}

export function configFromEnv(env = process.env) {
  const timeoutRaw = env.CODERIFTS_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === "" ? undefined : Number(timeoutRaw);
  return {
    apiKey: env.CODERIFTS_API_KEY || undefined,
    endpoint: env.CODERIFTS_ENDPOINT || undefined,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    operation: env.CODERIFTS_OPERATION || undefined,
    toolShapes: CLAUDE_TOOL_SHAPES,
  };
}

export function mapGateResult(result) {
  if (result === undefined) return emptyPass();
  if (result?.block) {
    return jsonDecision("deny", result.blockReason ?? "CodeRifts refused this contract change.");
  }
  const approval = result?.requireApproval;
  if (approval) {
    const reason = approval.description ?? approval.title ?? "CodeRifts asks for a human.";
    if (ASK_TITLES.has(approval.title)) return jsonDecision("ask", reason);
    return failClosed(reason);
  }
  return failClosed("CodeRifts gate returned a shape this adapter does not map. Not knowing is not permission.");
}

export async function runClaudeHook(stdinText, { env = process.env, deps } = {}) {
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch (err) {
    return failClosed(`CodeRifts Claude hook: stdin was not JSON (${err?.message ?? err}).`);
  }
  if (!payload || typeof payload !== "object") {
    return failClosed("CodeRifts Claude hook: stdin JSON was not an object.");
  }

  if (payload.tool_name === "Bash") {
    try {
      const r = await shellDecision(String(payload.tool_input?.command ?? ""), hostIo(payload.cwd, deps?.readFile, deps?.listDir));
      return r ? jsonDecision(r.decision, r.text) : emptyPass();
    } catch (err) {
      return failClosed(`CodeRifts Claude hook failed on a Bash call (${String(err?.message ?? err)}). Not knowing is not permission.`);
    }
  }

  const event = {
    toolName: payload.tool_name,
    params: payload.tool_input ?? {},
    cwd: payload.cwd,
  };

  try {
    const gate = createGate(configFromEnv(env), deps);
    const result = await gate(event);
    return mapGateResult(result);
  } catch (err) {
    return failClosed(
      `CodeRifts Claude hook failed before a decision (${String(err?.message ?? err)}). Not knowing is not permission.`,
    );
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const out = await runClaudeHook(raw);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exit(out.exitCode);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
