# Changelog

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
