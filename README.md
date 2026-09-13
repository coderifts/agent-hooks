# CodeRifts contract gate for OpenClaw

Asks CodeRifts before an OpenClaw agent writes a contract artifact — an OpenAPI, AsyncAPI, GraphQL,
protobuf or MCP manifest file. The answer becomes an OpenClaw `before_tool_call` result: the call
continues, stops, or waits for a human.

The gate makes no policy decisions of its own. It recognises the file, sends the before/after to
CodeRifts, and maps the answer back. Everything it cannot map, it puts to a human.

## What it does

| CodeRifts `execution_action` | OpenClaw result |
| --- | --- |
| `CONTINUE`, `CONTINUE_WITH_MONITORING` | pass through |
| `REQUEST_APPROVAL` | `requireApproval` |
| `STOP` | `block`, with the reason and its limits |
| anything else, or no answer | `requireApproval`, with a named reason |

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
`requireApproval` with the cause named — never a pass. Not knowing is not permission.

The gate's own budget defaults to 5000 ms, deliberately well under OpenClaw's 15000 ms
`before_tool_call` budget: a slow answer should become a readable approval request, not an opaque
host-level denial.

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

## Install

```bash
openclaw plugins install @coderifts/openclaw-plugin
```

## Test

```bash
npm test
```
