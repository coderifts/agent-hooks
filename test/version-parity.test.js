// One version for package.json, the Claude plugin manifest, the OpenClaw manifest and the marketplace
// entry (2026-10-03): the Claude manifest lagging package.json kept every install on 0.2.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, write, MANIFESTS } from '../scripts/sync-version.mjs';

test('every shipped manifest carries the package.json version', () => {
  const r = check();
  assert.deepEqual(r.drift, [], `drift: ${r.drift.map((d) => `${d.file}=${d.has}`).join(', ')} (package.json ${r.version})`);
});

test('a lagging manifest is named, and write() sets only its version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-version-'));
  try {
    for (const f of ['package.json', ...MANIFESTS]) cpSync(new URL(`../${f}`, import.meta.url), join(dir, f), { recursive: true });
    const plugin = join(dir, '.claude-plugin/plugin.json');
    const before = readFileSync(plugin, 'utf8');
    writeFileSync(plugin, before.replace(/"version":\s*"[^"]*"/, '"version": "0.0.1"'));
    assert.deepEqual(check(dir).drift.map((d) => d.file), ['.claude-plugin/plugin.json']);
    assert.deepEqual(write(dir).drift, []);
    assert.equal(readFileSync(plugin, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
