# Changelog

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
