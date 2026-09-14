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
 * `gate.js` is untouched. This file only remaps envelopes.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGate } from "../gate.js";

/** Claude Code Write/Edit/MultiEdit → the path/content keys `resolveTarget` reads. */
export const CLAUDE_TOOL_SHAPES = Object.freeze({
  Write: { path: "file_path", content: "content" },
  Edit: { path: "file_path", content: "new_string" },
  MultiEdit: { path: "file_path", content: "content" },
});

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

  const event = {
    toolName: payload.tool_name,
    params: payload.tool_input ?? {},
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
