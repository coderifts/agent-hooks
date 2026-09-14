# CodeRifts agent hooks (`@coderifts/agent-hooks`)

Asks CodeRifts before an agent writes a contract artifact — an OpenAPI, AsyncAPI, GraphQL,
protobuf or MCP manifest file. **Hosts today:** OpenClaw `before_tool_call` and Claude Code
`PreToolUse`. **Not built:** the Docker MCP Gateway `before:exec` interceptor — that path
was measured (empty stdout = pass, CallToolResult JSON = block, HTTP 4xx empty = fail-open)
and has no adapter in this package yet.

This is the host-adapter package. It is not `@coderifts/agent-guard` (the wrapWithGuard
library) and not `coderifts/contract-gate` (the GitHub Action). The npm name used to be
`@coderifts/openclaw-plugin`; that name is wrong now that more than one host is wired.

The same `gate.js` drives every host. The gate makes no policy decisions of its own. It
recognises the file, sends the before/after to CodeRifts, and maps the answer back.
Everything it cannot map, it puts to a human.

## What it does

| CodeRifts `execution_action` | OpenClaw | Claude Code PreToolUse |
| --- | --- | --- |
| `CONTINUE`, `CONTINUE_WITH_MONITORING` | pass through | exit 0, empty stdout (never `allow`) |
| `REQUEST_APPROVAL` | `requireApproval` | JSON `permissionDecision: "ask"` |
| `STOP` | `block`, with the reason and its limits | JSON `permissionDecision: "deny"` |
| anything else, or no answer | `requireApproval` | **exit 2 + stderr** (host is fail-open) |

## What it does not do

- **It does not gate what it does not recognise.** A tool call writing `README.md` passes untouched.
  The recognised set is a short, explicit list in `gate.js`; a gate that guesses at every file either
  blocks documentation or waves through a schema.
- **It does not turn a risk number into a verdict.** Without an API key CodeRifts answers in
  `analyze` mode, which returns `authorization_effect: "NONE"` and `may_execute: false` — risk
  information and no decision. The gate reports that and asks a human. It never reads a high score
  as a block or a low one as a pass.
- **It does not lock the file.** The bytes checked are the bytes in the tool params at the moment of
  the call. Nothing here holds them between the answer and the write.

Every refusal says so in its own text, so an agent reading the transcript can see how far the answer
reaches:

```
CodeRifts refused this contract change.
Reason: endpoint_removed — ENDPOINT_REMOVAL
Proves: the change set as this call would leave it was refused by CodeRifts under operation "tool_call".
Does not prove:
  - that the bytes finally written are the bytes checked — nothing here locks the file between this answer and the write
  - that the other tool calls in this run were checked — each call is judged alone
  - that a contract artifact this gate does not recognise was seen at all
```

## Fail-closed

If CodeRifts is unreachable, times out, or answers something the gate cannot read, the result is
not a pass. Not knowing is not permission.

The gate's own budget defaults to 5000 ms.

On **OpenClaw**, that is well under the host's 15000 ms `before_tool_call` budget, so a slow
answer becomes a readable approval request, not an opaque host denial. The host is fail-closed.

On **Claude Code**, the host is **fail-open**: a timed-out command hook, exit 1, invalid JSON,
or a missing script lets the tool run. The adapter therefore maps those failures to **exit 2**.
The hook entry sets `"timeout": 8` (**seconds** — Claude Code's unit, not milliseconds) so the
gate's 5000 ms abort can finish first. If `node` itself hangs past 8 s, Claude Code still
lets the write through. That host behaviour cannot be fixed in this package.

## What this gate does not see (Claude Code)

The Claude Code matcher is `Write|Edit|MultiEdit`. A contract file written by a **shell
command** (`cat > openapi.yaml`, `tee`, `python -c "open(...)"`, …) does not go through
those tools, so this hook never runs. Parsing Bash to guess destination paths is not a
gate — it would miss more than it caught. Treat a shell-written schema as unchecked.

Does not prove:
  - that a contract artifact written via Bash or PowerShell was seen at all

## Configuration

```json
{
  "plugins": {
    "entries": {
      "coderifts-contract-gate": {
        "config": {
          "apiKey": "...",
          "endpoint": "https://app.coderifts.com/mcp",
          "timeoutMs": 5000,
          "operation": "tool_call"
        }
      }
    }
  }
}
```

`apiKey` is optional in the schema and load-bearing in practice: **without it there is no decision.**
`preflight_mode=authorize` requires a verified issuer, so an unkeyed gate runs in `analyze` mode and
every gated call ends at a human. That is safe and it is noisy; the key is what makes it useful.

There is no setting that makes an unanswered call pass. That absence is the design.

## Hook placement

Registered on `before_tool_call` at `priority: 100`. OpenClaw runs handlers in descending priority
and keeps only the **first** `requireApproval`, so a gate that runs late can have its question
dropped by an earlier plugin. A `block` is sticky and survives regardless of order.

## Install — OpenClaw

```bash
openclaw plugins install @coderifts/agent-hooks
```

(OpenClaw still records the plugin under the runtime id `coderifts-contract-gate` — that is
the OpenClaw config key, not the GitHub Action.)

## Install — Claude Code

Copy `claude-code/settings.snippet.json` into `.claude/settings.json` (or merge the
`hooks` key), after `npm install @coderifts/agent-hooks`. Optional env:
`CODERIFTS_API_KEY`, `CODERIFTS_ENDPOINT`, `CODERIFTS_TIMEOUT_MS` (milliseconds, gate
budget; default 5000).

Plugin shape (for the existing `coderifts` marketplace): `.claude-plugin/plugin.json` +
`hooks/hooks.json`. Add `claude-code/marketplace-entry.json` to
`coderifts/api-governance` `.claude-plugin/marketplace.json` `plugins` array — that
catalog today lists only `api-governance`. Then:

```bash
claude plugin marketplace update coderifts
claude plugin install agent-hooks@coderifts
```

Do not use `permissionDecision: allow` for CONTINUE. Empty exit 0 leaves the normal
permission prompt in place.

## Test

```bash
npm test
```

`npm test` includes a pack-then-install case. In-repo imports cannot see a
`files` allowlist that dropped a relative module — that is how 0.1.0 shipped
without `gate.js`. The pack test also requires `claude-code/hook.mjs`. Do not
skip it.
