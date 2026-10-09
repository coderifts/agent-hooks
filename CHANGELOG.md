# Changelog

## 0.3.5 — 2026-10-09
### Fixed
- **The Claude Code hook runs when invoked through a symlinked path.** The entry check resolves the invoked path and this file. The same check in `scripts/sync-version.mjs` does too. If the check cannot tell, the entry runs.
- **contract-write 1.3.2 (no decision changes).** The generated copy adds `readPlan` and `pendingListings`.

## 0.3.4 — 2026-10-09
### Fixed
- **A plain `mcp.json` that is both an MCP client configuration and a tool manifest, or that does not parse, is not
  read or sent and is not passed (contract-write 1.3.1).** On the Claude Code file tools and on the OpenClaw tool
  shapes the gate asks, with one sentence: split the server list and the tool manifest into separate files, or make
  the file valid JSON (no comments) to have it checked.

## 0.3.3 — 2026-10-08
### Fixed
- **A plain `mcp.json` is decided by its content (contract-write 1.3.0, P65c).** 0.3.2 skipped every `mcp.json` by
  name, which also skipped a server's tool manifest of that name. By name only `.mcp.json`, `.cursor/mcp.json`,
  `.vscode/mcp.json`, `claude_desktop_config.json` and `(cline_)mcp_settings.json` stay skipped (never read). Any
  other `mcp.json` is read on disk: `mcpServers` / `servers` and no `tools` → a client configuration, nothing sent;
  `tools`, any other shape, or unparseable → checked as a contract. A manifest rewritten into a client configuration
  is checked as the manifest removed, without the client side. The same on the OpenClaw tool shapes (`write_file` …).

## 0.3.2 — 2026-10-06
### Fixed
- **An MCP client configuration is never treated as a contract (contract-write 1.2.0, P65).** `.mcp.json`, `mcp.json`
  (also under `.cursor/` and `.vscode/`), `claude_desktop_config.json` and `(cline_)mcp_settings.json`: an edit of one
  sent its whole text, the servers' `env` credentials included, to CodeRifts preflight. They are decided by name and
  never read; MCP tool manifests are unchanged.

## 0.3.1 — 2026-10-04

### Changed

- **When CodeRifts could not decide, the refusal says so in one sentence** — the one the GitHub App, `coderifts claude-hook` and the CodeRifts mod write: `GOVERNANCE_UNAVAILABLE: CodeRifts could not decide (<why>); this is not a finding about your change.` It is added to the unreachable and unreadable-answer approvals (`gate.js`) and to the Claude hook's fail-closed messages (`claude-code/hook.mjs`); nothing that stopped now passes. `governanceUnavailable(why)` is exported from `gate.js`.

## 0.3.0 — 2026-10-03

### Changed

- **One decision function with `coderifts claude-hook` and the CodeRifts mod.** `contract-write.mjs` (a byte copy of `@coderifts/contract-path`'s, with `contract-write.sha256` beside it) decides which path is a contract file and of what type, the text an Edit or MultiEdit leaves, and what a Bash command writes. `gate.js` and `claude-code/hook.mjs` keep no list of their own.
- **Artifact types are the change-set surface's own:** a `.proto` is sent as `grpc` and an MCP manifest or tool list as `mcp_manifest` (they were `protobuf` and `mcp`, which the surface does not analyze). `classifyPath` returns the new types; `ARTIFACT_TYPES` is gone.
- **Bash, by write target.** A shell write to a named contract file is still denied. A read of one now passes (`cat openapi.yaml > /tmp/x` was denied before). A write that can reach a contract file without naming it (`find … -exec sed -i`, `xargs`, a glob, `rm -rf <dir>`, `git stash pop`, `git reset --hard`, a pipe into `sh`) now **asks** when a contract file is under its reach.
- **Edit:** `replace_all` and the empty-`old_string` create form follow Claude Code; an edit that does not apply says which `old_string` was not found.
- **Two more limits** on every refusal: that the hook was running (`disableAllHooks` in any settings file, `--safe-mode`, `--bare`), and that a contract generated from source code was checked.

## 0.2.2 — 2026-10-03

### Changed

- **Every refusal names two more limits.** `DOES_NOT_PROVE` (gate.js), carried on every refusal and approval request, and inherited by the shell refusal, now also says:
  - that a refusal by a hook installed outside managed settings is not final: since Claude Code 2.1.287 a user-installed mod runs before it, can answer the call so the hook never runs, and can approve a call the hook blocked;
  - that a timed-out hook does not block the call: the fail-closed path covers an error inside the hook, not Claude Code's hook timeout. This holds for this hook only when `CODERIFTS_TIMEOUT_MS` is at least the hook timeout; the default 5000 ms aborts inside the 8 s timeout the snippet sets.

## Unreleased — 2026-09-27

### Fixed

- **Edit sent a fragment as the whole file.** `new_string` went to CodeRifts as the after body, so a
  one-line Edit read as "everything else was removed". The after body is now the file on disk with
  the edit applied (`replace_all` honoured); MultiEdit applies `edits` in order (it used to read a
  `content` key that MultiEdit does not have). An edit that does not apply → exit 2, nothing sent.
  The 0.2.0 test that pinned the fragment is rewritten; its `old_string` was not in the fixture.

### Changed

- **The Bash hole is narrowed, not closed.** Matcher `Write|Edit|MultiEdit|Bash`. A Bash command that
  names a recognised contract file with a write shape is **denied** with a pointer to Write/Edit;
  reads pass; nothing is sent to CodeRifts. Deny, not ask (#39344: a hook ask was reported to
  override a settings deny). A write that does not name the file is still not seen — the refusal
  text says so. Same bypass class as anthropics/claude-code #31292.

## 0.2.0 — 2026-09-13

**(a) New host.** Claude Code PreToolUse adapter. Same `gate.js`; new stdin envelope.

**(b) Rename.** npm package is `@coderifts/agent-hooks` (was `@coderifts/openclaw-plugin`).
The package is no longer one host's plugin: OpenClaw and Claude Code share `gate.js`,
and a Docker `before:exec` adapter is measured but not shipped. The Claude marketplace
plugin id is `agent-hooks`, not `contract-gate` — that name is the GitHub Action
(`coderifts/contract-gate`). `@coderifts/agent-guard` remains the wrapWithGuard library.

### Added

- `claude-code/hook.mjs`: maps Write/Edit/MultiEdit stdin JSON onto `createGate`, then:
  - CONTINUE → exit 0, empty stdout (never `permissionDecision: allow`)
  - REQUEST_APPROVAL / keyless analyze → JSON `ask`
  - STOP → JSON `deny` (reason still carries Does not prove)
  - unreachable / unreadable / throw / bad stdin → **exit 2 + stderr** because Claude Code command hooks are fail-open on timeout, exit 1, and missing scripts
- Plugin wiring: `hooks/hooks.json` (`timeout: 8` **seconds**), `.claude-plugin/plugin.json`, copyable `claude-code/settings.snippet.json`, `claude-code/marketplace-entry.json` for the existing `coderifts` marketplace
- Adapter tests (`test/claude-hook.test.js`) and pack coverage for the adapter file

### Limits (named, not silent)

- **Host timeout fail-open.** Hook config `timeout` is seconds (default 600). We set 8, above the gate's 5000 ms, so a slow CodeRifts answer becomes exit 2 from us. If `node` hangs past 8 s, Claude Code **still lets the tool run**. This cannot be fixed in the hook.
- **Bash hole.** Matcher is `Write|Edit|MultiEdit`. A shell command that writes `openapi.yaml` (`cat > …`, `tee`, …) is not seen. Parsing those commands is not a gate; the README says so.

## 0.1.1 — 2026-09-13

**0.1.0 was broken.** `npm pack` / `openclaw plugins install` shipped a tarball
without `gate.js`. `index.js` imports `./gate.js`, so the installed plugin failed
to load (`Cannot find module './gate.js'`). The 14 in-repo tests imported from
the checkout, not from the packed tarball, and did not catch this.

### Fixed

- Include `gate.js` in `package.json` `"files"`.
- Add a pack-then-install test (`test/pack.test.js`) that fails if any relative
  import of the packed `index.js` is missing from the tarball.
- Declare `openclaw` as a peerDependency (`>=2026.6.35`, optional so npm does
  not fetch the host as a nested install). Without the peer, `npm install` of
  0.1.0 was silent about a missing host.
- Add `openclaw.build.openclawVersion` (`2026.6.35`) — ClawHub `package publish`
  rejects external code plugins that omit it.

## 0.1.0 — 2026-09-13

Initial release. **Do not use.** The published tarball omitted `gate.js`.
Use 0.1.1.
