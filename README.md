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
  - that the call was refused when this hook is installed outside managed settings — since Claude Code 2.1.287 a user-installed mod runs before it, can answer the call so the hook never runs, and can approve a call the hook blocked; only a hook in managed settings is final
  - that a call was refused when the hook ran out of time — the fail-closed path covers an error inside the hook, not Claude Code's hook timeout: a timed-out PreToolUse command hook does not block the call (true for this hook only when CODERIFTS_TIMEOUT_MS is at least the hook timeout)
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

## Shell writes (Claude Code)

The Claude Code matcher is `Write|Edit|MultiEdit|Bash`. A shell command cannot be gated — the
hook never sees the bytes it would leave — so the hook reads what the command **writes**, with the
decision function `coderifts claude-hook` and the CodeRifts mod use too (`contract-write.mjs`, a
copy of `@coderifts/contract-path`'s):

- **A write to a named contract file is denied** (a redirect into it, `tee`, `sed -i`/`perl -i`,
  the destination of `cp`/`install`/`ln`/`rsync`, `mv`/`rm`, `git checkout|restore -- <file>`,
  `--out <file>`, `open(<file>, "w")` in inline Python or Node, `curl -o`), with a pointer to the
  Write or Edit tool, where the gate does see the change. Nothing is sent to CodeRifts for a Bash call.
- **A write that can reach a contract file without naming it asks**: `find <dir> -exec sed -i …`
  or `-delete`, `xargs` into a writer, a glob, `rm -rf <dir>`, `git stash pop`, `git reset --hard`,
  `git checkout -- .`, inline code that walks a directory, a pipe into `sh`, a target the command
  builds from a variable it does not set. It asks only when a contract file is under that
  directory; `find . -name '*.pyc' -delete` and `rm -rf build` pass.
- **A read passes**, even of a contract file: `cat openapi.yaml > /tmp/copy`, `cp openapi.yaml /tmp/`,
  `git diff`, `grep`, `oasdiff`.

Measured on 2026-10-03 against 20,930 distinct Bash commands from local Claude Code sessions, read
against a repository full of contract files: 15 named writes were denied and 261 commands asked
(1.2%); against a repository without a contract file nothing asked. In a sample of 25 of those asks, 4
rewrote the working tree (`git stash`, `git stash pop`) and 21 wrote a target the command text does not
resolve (a variable set by an earlier command, a path computed in code). On the 22 benign forms of the Skillkeel tamper
corpus nothing was refused or asked.

An ask does not weaken a deny: on Claude Code 2.1.288 a settings `deny` rule held over this hook's
`ask` and over an `allow` (measured in `bypassPermissions` mode). The earlier report that a hook ask
overrode a deny rule (anthropics/claude-code #39344) did not reproduce.

It reads the command text; it does not parse shell or run it. A command shape it does not recognise
passes — a script that writes a contract file itself (`node scripts/generate.js`), a variable it
cannot resolve to a name — and every shell refusal says so:

Does not prove:
  - that a contract file written by a shell command this hook did not recognise was seen at all

The sandbox closes what the text cannot: with `sandbox.filesystem.denyWrite` listing the contract
paths, every sandboxed command and its child processes are refused the write (measured on macOS:
`python -c`, `find -exec sed -i`, `xargs cp`, also in `bypassPermissions` mode; on Linux a wildcard
entry is skipped, so list concrete paths). The Write and Edit tools stay with this hook.

## Edit and MultiEdit

`new_string` is a fragment, not the file. The gate reads the file on disk and sends it with the
edit applied (MultiEdit: every edit, in order). An edit whose `old_string` is not in the file is
not guessed: exit 2.

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
