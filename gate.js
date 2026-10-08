/**
 * The gate itself, with no OpenClaw imports, so it can be exercised directly.
 *
 * `index.js` is the OpenClaw entry; everything decidable lives here.
 */

import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
// The one decision function this hook, `coderifts claude-hook` and the CodeRifts mod share
// (2026-10-03): which path is a contract and of what type, the after text of an Edit, what a shell
// command writes. A byte copy of @coderifts/contract-path's contract-write.mjs, written by the app's
// scripts/generate-contract-write-copies.js; contract-write.sha256 beside it is checked by
// test/contract-write-copy.test.js.
import { contractType, decideToolCall, isClientConfigContent, toolKind } from "./contract-write.mjs";

/** Tools whose params carry a path and a new file body. */
export const DEFAULT_TOOL_SHAPES = Object.freeze({
  write_file: { path: "path", content: "content" },
  create_file: { path: "path", content: "content" },
  edit_file: { path: "path", content: "content" },
  str_replace_editor: { path: "path", content: "new_str" },
});

/**
 * The contract type of a path (contract-write's list: OpenAPI/Swagger, AsyncAPI, GraphQL, protobuf,
 * MCP manifests and tool lists, agent tool schemas), or null. Until 0.3.0 this file kept its own
 * list and sent `protobuf` and `mcp`, which the change-set surface does not analyze; the types are
 * now the surface's own (`grpc`, `mcp_manifest`). What is not on the list is not gated, and the
 * refusal text says so.
 */
export function classifyPath(p) {
  return contractType(p);
}

/**
 * What this gate proves, and what it does not. Carried on EVERY refusal.
 *
 * An agent that reads "DENIED" and nothing else learns only that something said no. These lines are
 * the difference between a policy engine's verdict and a reviewable one: they tell the agent — and
 * the human reading the transcript — exactly how far the answer reaches.
 */
export const DOES_NOT_PROVE = Object.freeze([
  "that the bytes finally written are the bytes checked — nothing here locks the file between this answer and the write",
  "that the other tool calls in this run were checked — each call is judged alone",
  "that a contract artifact this gate does not recognise was seen at all",
  "that the call was refused when this hook is installed outside managed settings — since Claude Code 2.1.287 a user-installed mod runs before it, can answer the call so the hook never runs, and can approve a call the hook blocked; only a hook in managed settings is final, and a plugin hook runs after the mods even when managed settings force-enable the plugin",
  "that a call was refused when the hook ran out of time — the fail-closed path covers an error inside the hook, not Claude Code's hook timeout: a timed-out PreToolUse command hook does not block the call (true for this hook only when CODERIFTS_TIMEOUT_MS is at least the hook timeout)",
  // 0.3.0 (2026-10-03), measured on Claude Code 2.1.288 with a probe plugin: disableAllHooks from
  // --settings and from the project's .claude/settings.json, --safe-mode and --bare each stopped a
  // plugin's PreToolUse hook; a shell command rewrote .claude/settings.json unless the sandbox was on.
  "that the hook was running — disableAllHooks in any settings file (the project's .claude/settings.json included, which a shell command can rewrite unless the sandbox protects it), --safe-mode or --bare turns it off",
  "that a contract generated from source code was checked — a contract generated from source code (annotations, decorators, a build step) changes when the source changes; the hooks see the source edit, not the contract; the required check sees the generated contract",
]);

/**
 * What the answer actually establishes. The verb has to match the verdict: a refusal was refused, an
 * approval request was NOT — writing "refused" on an approval would be the gate overstating its own
 * answer in the one sentence meant to bound it.
 */
const proves = (op, verb) =>
  `Proves: the change set as this call would leave it was ${verb} by CodeRifts under operation "${op}".`;

const limits = () => DOES_NOT_PROVE.map((l) => `  - ${l}`).join("\n");

/** Build the refusal text an agent will actually read. */
export function blockText(op, why) {
  return [
    `CodeRifts refused this contract change.`,
    why ? `Reason: ${why}` : null,
    proves(op, "refused"),
    `Does not prove:`,
    limits(),
  ]
    .filter(Boolean)
    .join("\n");
}

/** One JSON-RPC POST. No session handshake, no SDK — measured to be all the surface needs. */
export async function askCodeRifts({ endpoint, apiKey, timeoutMs, operation, artifact }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (apiKey) headers["X-API-Key"] = apiKey;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "preflight_change_set",
          arguments: {
            // authorize is the only mode that carries a decision. Without a key the server answers
            // authorization_requires_issuer, so an unkeyed gate asks in analyze mode and then has
            // to fall to approval — see decide().
            preflight_mode: apiKey ? "authorize" : "analyze",
            context: { operation },
            artifacts: [artifact],
          },
        },
      }),
    });
    if (!res.ok) return { kind: "unreachable", detail: `HTTP ${res.status}` };
    const env = await res.json();
    if (env.error) return { kind: "unusable", detail: env.error.message ?? "JSON-RPC error" };
    const text = env?.result?.content?.[0]?.text;
    if (typeof text !== "string") return { kind: "unusable", detail: "no content in response" };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "unusable", detail: "response was not JSON" };
    }
    if (body?.error) return { kind: "unusable", detail: body.message ?? body.error };
    return { kind: "ok", body };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { kind: "unreachable", detail: aborted ? `no answer within ${timeoutMs}ms` : String(err?.message ?? err) };
  }
}

/**
 * GOVERNANCE_UNAVAILABLE (2026-10-04): the one sentence the App, the CLI hook and the Claude Code mod
 * write verbatim when CodeRifts could not decide. The call still stops; the sentence says the stop is
 * about CodeRifts, not about the change.
 */
export function governanceUnavailable(why) {
  return `GOVERNANCE_UNAVAILABLE: CodeRifts could not decide (${why}); this is not a finding about your change.`;
}

/** Ask for a human, always with a reason. Never `{}`. */
const ask = (title, description) => ({
  requireApproval: {
    title,
    description,
    severity: "warning",
    // Explicit "deny", not because it is honoured everywhere — on current OpenClaw unresolved
    // approvals always deny and this field is deprecated — but because on the extended-stable line
    // it is still read, and "allow" there would be a genuine fail-open.
    timeoutBehavior: "deny",
  },
});

/**
 * Turn one CodeRifts answer into one OpenClaw hook result.
 *
 * The three shapes are the host's, measured: `undefined` passes, `{block, blockReason}` refuses,
 * `{requireApproval}` asks. There is no fourth, and no default pass.
 */
export function decide(outcome, { operation, path }) {
  if (outcome.kind === "unreachable") {
    return ask(
      "CodeRifts did not answer",
      `${path} is a contract artifact and CodeRifts could not be reached (${outcome.detail}). ` +
        `${governanceUnavailable(`CodeRifts could not be reached: ${outcome.detail}`)} ` +
        `No decision was obtained, and not knowing is not permission.`,
    );
  }
  if (outcome.kind === "unusable") {
    return ask(
      "CodeRifts answer could not be read",
      `${path} is a contract artifact and CodeRifts replied with something this gate cannot interpret ` +
        `(${outcome.detail}). ${governanceUnavailable(`the answer could not be read: ${outcome.detail}`)} ` +
        `No decision was obtained, and not knowing is not permission.`,
    );
  }

  const body = outcome.body;

  // The analyze path says so about itself. Reading its risk number as a verdict would be this
  // plugin inventing a policy engine, which is the one thing it must not do.
  if (body.authorization_effect === "NONE" || body.may_execute === false && !body.execution_action) {
    return ask(
      "CodeRifts returned analysis, not authorization",
      `${path} is a contract artifact. Without an API key CodeRifts answers in analyze mode ` +
        `(authorization_effect=${String(body.authorization_effect)}, may_execute=${String(body.may_execute)}), ` +
        `which carries risk information and no decision` +
        (body.risk_score !== undefined ? ` (risk_score ${body.risk_score}` +
          (Array.isArray(body.patterns) && body.patterns.length ? `, ${body.patterns.join(", ")}` : "") + `)` : "") +
        `. Configure apiKey to get a decision; until then every gated call asks.`,
    );
  }

  switch (body.execution_action) {
    case "CONTINUE":
    case "CONTINUE_WITH_MONITORING":
      return undefined;
    case "REQUEST_APPROVAL":
      return ask(
        "CodeRifts asks for approval",
        `${path} — CodeRifts returned ${body.execution_action} for operation "${operation}"` +
          (body.risk_score !== undefined ? `, risk_score ${body.risk_score}` : "") +
          (Array.isArray(body.patterns) && body.patterns.length ? `, ${body.patterns.join(", ")}` : "") +
          `.\n${proves(operation, "put to a human")}\nDoes not prove:\n${limits()}`,
      );
    case "STOP":
      return {
        block: true,
        blockReason: blockText(
          operation,
          [
            body.decision_basis?.rule_ids?.join(", "),
            Array.isArray(body.patterns) && body.patterns.length ? body.patterns.join(", ") : null,
          ]
            .filter(Boolean)
            .join(" — ") || undefined,
        ),
      };
    default:
      return ask(
        "CodeRifts returned an action this gate does not know",
        `${path} — execution_action was ${JSON.stringify(body.execution_action)}. ` +
          `An unrecognised action is not a pass.`,
      );
  }
}

/**
 * Resolve the file this tool call would write, if any.
 *
 * `derivedPaths` is the host's own hint and is documented as best-effort, so it is used to widen the
 * search, never to replace reading `params`.
 */
export function resolveTarget(event, shapes) {
  const shape = shapes[event.toolName];
  const fromParams = shape ? event.params?.[shape.path] : undefined;
  const candidates = [fromParams, ...(event.derivedPaths ?? [])].filter((p) => typeof p === "string" && p);
  for (const p of candidates) {
    const type = classifyPath(p);
    if (type) return { path: p, type, content: shape ? event.params?.[shape.content] : undefined, apply: shape?.apply };
  }
  return null;
}

/** The host readers contract-write takes: a missing file is null, an unreadable one throws. */
export function hostIo(cwd, read = (p) => readFile(p, "utf8"), list = defaultListDir) {
  const abs = (p) => (isAbsolute(p) ? p : resolve(cwd || process.cwd(), p));
  return {
    cwd: cwd || process.cwd(),
    readFile: async (p) => {
      try {
        return await read(abs(p));
      } catch (err) {
        if (err && err.code === "ENOENT") return null;
        throw err;
      }
    },
    listDir: (dir) => list(abs(dir)),
  };
}

async function defaultListDir(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : "file" }));
  } catch {
    return null;
  }
}

async function gateClaudeCall(event, { read, call, endpoint, apiKey, timeoutMs, operation }) {
  const d = await decideToolCall({ tool: event.toolName, input: event.params ?? {} }, hostIo(event.cwd, read));
  if (d.action === "pass") return undefined;
  if (d.action !== "gate") {
    return ask("CodeRifts gate could not read the proposed change", `${d.why}. It will not pass a change it has not seen.`);
  }
  const outcome = await call({
    endpoint,
    apiKey,
    timeoutMs,
    operation,
    artifact: { id: d.path, type: d.type, before: d.before, after: d.after },
  });
  return decide(outcome, { operation, path: d.path });
}

/** The handler, with its I/O injected so a test can drive it without a network or a disk. */
export function createGate(config = {}, deps = {}) {
  const endpoint = config.endpoint ?? "https://app.coderifts.com/mcp";
  const apiKey = config.apiKey;
  const timeoutMs = config.timeoutMs ?? 5000;
  const operation = config.operation ?? "tool_call";
  const shapes = { ...DEFAULT_TOOL_SHAPES, ...(config.toolShapes ?? {}) };
  const call = deps.askCodeRifts ?? askCodeRifts;
  const read = deps.readFile ?? ((p) => readFile(p, "utf8"));

  return async function beforeToolCall(event) {
    // A Claude Code file tool (Write / Edit / MultiEdit): contract-write decides the path, the type
    // and the after text, as the CLI hook and the mod do.
    const claudeTool = toolKind(event.toolName);
    if (claudeTool && claudeTool !== "Bash") return gateClaudeCall(event, { read, call, endpoint, apiKey, timeoutMs, operation });

    const target = resolveTarget(event, shapes);
    // Not a contract artifact this gate recognises. Staying out of the way is not a fail-open: the
    // gate never claimed this call, and DOES_NOT_PROVE says as much on every refusal it does make.
    if (!target) return undefined;
    if (!target.apply && typeof target.content !== "string") {
      return ask(
        "CodeRifts gate could not read the proposed change",
        `${target.path} is a contract artifact, but this gate could not find the new content in the ` +
          `params of "${event.toolName}". It will not pass a change it has not seen.`,
      );
    }

    let before = "";
    try {
      before = await read(target.path);
    } catch {
      before = ""; // A new file. An empty "before" is a real change set, not a missing one.
    }

    // A tool whose params carry an edit, not a body (Claude Code Edit/MultiEdit): the after body is
    // the file with the edit applied. An edit that does not apply is put to a human — sending a
    // fragment as the whole file would read as "everything else was removed".
    const after = target.apply ? target.apply(event.params ?? {}, before) : target.content;
    if (typeof after !== "string") {
      return ask(
        "CodeRifts gate could not read the proposed change",
        `${target.path} is a contract artifact, but the edit in "${event.toolName}" does not apply to ` +
          `the file as it is on disk. It will not pass a change it has not seen.`,
      );
    }

    // 0.3.3 (P65c): a plain mcp.json is decided by its content (contract-write's function), as on the
    // Claude Code path. A side that is an MCP client configuration counts as no file and is never sent;
    // both such sides → this gate never claimed the call.
    const clientBefore = isClientConfigContent(target.path, before);
    const clientAfter = isClientConfigContent(target.path, after);
    const sentBefore = clientBefore ? "" : before;
    const sentAfter = clientAfter ? "" : after;
    if ((clientBefore || clientAfter) && sentBefore === "" && sentAfter === "") return undefined;

    const outcome = await call({
      endpoint,
      apiKey,
      timeoutMs,
      operation,
      artifact: { id: target.path, type: target.type, before: sentBefore, after: sentAfter },
    });
    return decide(outcome, { operation, path: target.path });
  };
}
