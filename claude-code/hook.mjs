/**
 * Claude Code PreToolUse adapter. Translates the host's stdin JSON into the
 * OpenClaw-shaped event `createGate` already understands, then maps the three
 * gate results onto the Claude Code contract (measured 2026-09-13):
 *
 *   undefined           → exit 0, empty stdout (NOT permissionDecision allow)
 *   requireApproval     → JSON ask  (named CodeRifts decision)
 *   block               → JSON deny (reason includes Does not prove)
 *   transport/parse/throw → exit 2 + stderr (the gate's own rejection; exit 2 blocks
 *                         the tool call (Claude Code hooks documentation; measured 2026-09-13))
 *
 * The host effect (a timeout, an exit other than 0 or 2, and a missing executable block the
 * tool call when onFailure is block, and stay fail-open otherwise) is stated on the Claude Code
 * hooks documentation page, read 2026-11-20. It is not measured on a live host in this repository.
 * The adapter's own exit 2 and the onFailure field are measured in the tests.
 *
 * Which call touches a contract file is decided by contract-write.mjs, the one decision function
 * `coderifts claude-hook` and the CodeRifts mod run too (0.3.0, 2026-10-03):
 *   - Edit/MultiEdit carry an edit, not a body; the after file is the one on disk with it applied.
 *   - Bash is not gated (the after bytes are unknown). A command that writes a named contract file
 *     is denied with a pointer to Write/Edit, where the gate does see it; one that can write a
 *     directory holding a contract without naming it (find -exec, xargs, a glob, a tree-wide git
 *     restore, an interpreter, a pipe into sh) asks.
 *   - contract-write already splits on &&, ||, ;, |, &, and newlines and keeps the strictest
 *     result. eval is denied. A backtick, $(…), or base64 -d piped into sh or bash is denied
 *     when the ordinary decision would pass, and left as an ask when a contract may be in reach.
 *     sh -c / bash -c with no write target is denied; a visible write keeps the ordinary decision.
 *     A named contract write stays that denial.
 *   - REPL is matched for Code Mode. tool_input.code is read as text. A forbidden command or a
 *     contract path denies. The reason says the hook does not see values computed at run time.
 */
import { afterText, contractType, decideToolCall, shellWriteTargets } from "../contract-write.mjs";
import { invokedDirectly } from "../entry-guard.mjs";
import { createGate, DOES_NOT_PROVE, governanceUnavailable, hostIo } from "../gate.js";

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

const SHELL_PREFIXES = new Set(["sudo", "command", "exec", "time", "nohup", "env", "nice"]);

/** Split on &&, ||, ;, |, &, and newlines, outside quotes. */
function splitShell(command) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function leadingArgv(segment) {
  const words = [];
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) words.push(m[1] ?? m[2] ?? m[3]);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  while (i < words.length && SHELL_PREFIXES.has(words[i])) i += 1;
  return words.slice(i);
}

const hasCFlag = (argv) => argv.some((w) => w === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));

function commandBase(segment) {
  return String(leadingArgv(segment)[0] || "").split("/").pop();
}

const BASE64_PIPE = /base64\b[^|\n]*?(?:\s|^)(?:-d|--decode)\b[^|\n]*\|\s*(sh|bash)\b/;

function shellCBase(text) {
  for (const part of splitShell(text)) {
    const base = commandBase(part);
    if ((base === "sh" || base === "bash") && hasCFlag(leadingArgv(part))) return base;
  }
  return null;
}

/**
 * Unchecked shape to deny, or null to keep the ordinary decision.
 * `ordinary` is `pass` or `ask` (a named deny is returned before this runs).
 * An ask is not upgraded: $(…) or a pipe into a shell that already asks stays an ask.
 * eval is denied either way. sh -c / bash -c is denied only when it has no write target.
 */
function opaqueShellShape(command, ordinary) {
  const text = String(command ?? "");
  if (splitShell(text).some((part) => commandBase(part) === "eval")) return "eval";
  if (ordinary === "ask") return null;
  if (text.includes("`") || text.includes("$(")) return "command substitution";
  if (BASE64_PIPE.test(text)) return "base64 -d piped into a shell";
  const shell = shellCBase(text);
  if (shell && shellWriteTargets(text).length === 0) return `${shell} -c`;
  return null;
}

function opaqueDenyText(shape) {
  return [
    `CodeRifts cannot read this shell shape (${shape}), so the call is denied.`,
    "The hook does not run the command. sh -c, bash -c, eval, $(…), a backtick, and base64 -d piped into a shell are denied even when the inner text would pass.",
    "Not knowing is not permission.",
  ].join("\n");
}

function contractPathsIn(text) {
  const found = [];
  const re = /['"]([^'"\n]+\.(?:ya?ml|json|graphql|gql|proto))['"]/gi;
  for (const m of String(text).matchAll(re)) {
    if (contractType(m[1]) && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** $`…`, $(…), sh -c, bash -c, eval, or base64 -d piped into a shell, as text in REPL code. */
function replOpaqueShape(code) {
  const text = String(code ?? "");
  if (/\$`[^`]*`/.test(text)) return "a $`…` shell template";
  if (text.includes("$(")) return "command substitution";
  if (/base64\b[^|\n]*?(?:\s|^)(?:-d|--decode)\b[^|\n]*\|\s*(sh|bash)\b/.test(text)) return "base64 -d piped into a shell";
  if (/(?:^|[^A-Za-z0-9_./-])(?:sh|bash)(?:\s+-[A-Za-z]+)*\s+-c\b/.test(text)) return "sh -c or bash -c";
  if (/(?:^|[^A-Za-z0-9_])eval(?=\s|\s*["'`(])/.test(text)) return "eval";
  return null;
}

async function deniedCommandText(text, io) {
  const re = /'([^']*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const span = m[1] ?? m[2];
    if (!span || span.length > 2000) continue;
    const d = await shellDecision(span, io);
    if (d?.decision === "deny") return span.slice(0, 160);
  }
  return null;
}

/** Denial text for REPL code, or null when the text names nothing this hook refuses. */
async function replDecision(code, io) {
  const text = String(code ?? "");
  const paths = contractPathsIn(text);
  const shape = replOpaqueShape(text);
  const named = await deniedCommandText(text, io);
  if (!paths.length && !shape && !named) return null;
  const why = [
    paths.length ? `a contract path (${paths.join(", ")})` : null,
    shape ? `an unchecked shell shape (${shape})` : null,
    named ? `a shell command that writes a contract file (${named})` : null,
  ].filter(Boolean).join("; ");
  return [
    `CodeRifts denies this REPL program because its text contains ${why}.`,
    "The hook does not see values computed at run time.",
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
    try {
      const command = String(payload.tool_input?.command ?? "");
      const io = hostIo(payload.cwd, deps?.readFile, deps?.listDir);
      const r = await shellDecision(command, io);
      if (r?.decision === "deny") return jsonDecision("deny", r.text);
      const shape = opaqueShellShape(command, r?.decision ?? "pass");
      if (shape) return jsonDecision("deny", opaqueDenyText(shape));
      return r ? jsonDecision(r.decision, r.text) : emptyPass();
    } catch (err) {
      return failClosed(`CodeRifts Claude hook failed on a Bash call (${String(err?.message ?? err)}). ${governanceUnavailable("the Bash check failed")} Not knowing is not permission.`);
    }
  }

  if (payload.tool_name === "REPL") {
    try {
      const io = hostIo(payload.cwd, deps?.readFile, deps?.listDir);
      const text = await replDecision(String(payload.tool_input?.code ?? ""), io);
      return text ? jsonDecision("deny", text) : emptyPass();
    } catch (err) {
      return failClosed(`CodeRifts Claude hook failed on a REPL call (${String(err?.message ?? err)}). ${governanceUnavailable("the REPL check failed")} Not knowing is not permission.`);
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
      `CodeRifts Claude hook failed before a decision (${String(err?.message ?? err)}). ${governanceUnavailable("the hook failed before a decision")} Not knowing is not permission.`,
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

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main();
}
