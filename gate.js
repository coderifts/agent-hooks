/**
 * The gate itself, with no OpenClaw imports, so it can be exercised directly.
 *
 * `index.js` is the OpenClaw entry; everything decidable lives here.
 */

import { readFile } from "node:fs/promises";

/**
 * Path suffix -> the `type` the CodeRifts change-set surface expects.
 *
 * Deliberately a short, explicit list. A gate that tries to recognise every contract artifact ends
 * up guessing, and a gate that guesses either blocks documentation or waves through a schema. What
 * is not on this list is not gated — and the approval text says so, so nobody reads a CONTINUE as
 * "the whole change was checked".
 */
export const ARTIFACT_TYPES = Object.freeze([
  [/(^|\/)openapi[^/]*\.(ya?ml|json)$/i, "openapi"],
  [/(^|\/)swagger[^/]*\.(ya?ml|json)$/i, "openapi"],
  [/(^|\/)asyncapi[^/]*\.(ya?ml|json)$/i, "asyncapi"],
  [/\.graphql$|\.gql$/i, "graphql"],
  [/\.proto$/i, "protobuf"],
  [/(^|\/)(mcp|tools)\.(wire\.v1\.)?json$/i, "mcp"],
]);

/** Tools whose params carry a path and a new file body. */
export const DEFAULT_TOOL_SHAPES = Object.freeze({
  write_file: { path: "path", content: "content" },
  create_file: { path: "path", content: "content" },
  edit_file: { path: "path", content: "content" },
  str_replace_editor: { path: "path", content: "new_str" },
});

export function classifyPath(p) {
  for (const [re, type] of ARTIFACT_TYPES) if (re.test(p)) return type;
  return null;
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
async function askCodeRifts({ endpoint, apiKey, timeoutMs, operation, artifact }) {
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
        `No decision was obtained, and not knowing is not permission.`,
    );
  }
  if (outcome.kind === "unusable") {
    return ask(
      "CodeRifts answer could not be read",
      `${path} is a contract artifact and CodeRifts replied with something this gate cannot interpret ` +
        `(${outcome.detail}). No decision was obtained, and not knowing is not permission.`,
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
    if (type) return { path: p, type, content: shape ? event.params?.[shape.content] : undefined };
  }
  return null;
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
    const target = resolveTarget(event, shapes);
    // Not a contract artifact this gate recognises. Staying out of the way is not a fail-open: the
    // gate never claimed this call, and DOES_NOT_PROVE says as much on every refusal it does make.
    if (!target) return undefined;
    if (typeof target.content !== "string") {
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

    const outcome = await call({
      endpoint,
      apiKey,
      timeoutMs,
      operation,
      artifact: { id: target.path, type: target.type, before, after: target.content },
    });
    return decide(outcome, { operation, path: target.path });
  };
}
