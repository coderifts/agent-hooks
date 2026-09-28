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
 * Two Claude-specific inputs are resolved here, before the gate (2026-09-27):
 *   - Edit/MultiEdit carry an edit, not a body; `applyEdits` builds the after file from the one on disk.
 *   - Bash is not gated (the after bytes are unknown), but a command that names a recognised contract
 *     file with a write shape is denied with a pointer to Write/Edit, where the gate does see it.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyPath, createGate, DOES_NOT_PROVE } from "../gate.js";

/** One Claude Code edit applied to `text`; null when old_string is not there to replace. */
function applyOne(text, { old_string: from, new_string: to, replace_all: all } = {}) {
  if (typeof from !== "string" || typeof to !== "string") return null;
  if (from === "") return text === "" ? to : null; // Claude Code's "create via Edit" shape
  if (!text.includes(from)) return null;
  return all ? text.split(from).join(to) : text.replace(from, () => to);
}

/** The file after an Edit (`params` is the edit) or a MultiEdit (`params.edits`, in order). */
export function applyEdits(params, before) {
  const edits = Array.isArray(params.edits) ? params.edits : [params];
  let text = before;
  for (const e of edits) {
    text = applyOne(text, e);
    if (text === null) return null;
  }
  return text;
}

/** Claude Code Write/Edit/MultiEdit → the path/content keys `resolveTarget` reads. */
export const CLAUDE_TOOL_SHAPES = Object.freeze({
  Write: { path: "file_path", content: "content" },
  Edit: { path: "file_path", apply: applyEdits },
  MultiEdit: { path: "file_path", apply: applyEdits },
});

/*
 * A write shape in a shell command. Not a parser and not a gate: it only decides whether a command
 * that already NAMES a recognised contract file may be changing it. A miss is named in the refusal
 * text (and the README); a false hit costs one redirect to the Write/Edit tool.
 */
const SHELL_WRITE = [
  />/, // any redirect, incl. >> and heredoc targets
  /\btee\b/,
  /\b(sed|perl|ruby)\b[^|;&]*\s-[a-zA-Z]*i/,
  /\b(cp|mv|rm|truncate|install|ln|rsync|dd|patch|unzip|tar)\b/,
  /\bgit\s+(checkout|restore|apply|am|reset|stash|mv|rm)\b/,
  /\bopen\s*\([^)]*,\s*['"][wax+]/,
  /\b(writeFile(Sync)?|write_text|write_bytes)\b/,
  /\b(curl|wget)\b[^|;&]*\s-(o|O)\b/,
];

/** Tokens a shell would split on, then the ones this gate recognises as a contract path. */
function contractPathsIn(command) {
  const tokens = command.split(/[\s;|&<>()'"`=,]+/).filter(Boolean);
  return [...new Set(tokens.filter((t) => classifyPath(t)))];
}

const SHELL_DOES_NOT_PROVE = [
  "that a contract file written by a shell command this hook did not recognise was seen at all",
  ...DOES_NOT_PROVE.slice(1),
];

export function shellContractWrite(command) {
  if (typeof command !== "string") return null;
  // A redirect into a file descriptor (2>&1, >&2) is not a write to a path.
  const probe = command.replace(/\d?>&\d/g, " ");
  const paths = contractPathsIn(probe);
  if (!paths.length || !SHELL_WRITE.some((re) => re.test(probe))) return null;
  return [
    `CodeRifts cannot see a contract change made by a shell command (${paths.join(", ")}).`,
    `Use the Write or Edit tool for contract files, so the change is checked before it lands.`,
    `Proves: only that this command names a recognised contract file with a write shape.`,
    `Does not prove:`,
    ...SHELL_DOES_NOT_PROVE.map((l) => `  - ${l}`),
  ].join("\n");
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
    const refusal = shellContractWrite(payload.tool_input?.command);
    return refusal ? jsonDecision("deny", refusal) : emptyPass();
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
