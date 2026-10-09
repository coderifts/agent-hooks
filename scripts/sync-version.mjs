#!/usr/bin/env node
/*
 * One version for every manifest this package ships (2026-10-03).
 *
 * MEASURED: package.json said 0.2.2 while .claude-plugin/plugin.json said 0.2.0, and Claude Code reads
 * the plugin manifest — so every install stayed on 0.2.0, the release whose Edit hook sent the
 * replacement fragment as the whole file and refused every contract edit (fixed in 0.2.1). The
 * marketplace entry and the OpenClaw manifest were on 0.2.0 too.
 *
 * package.json is the source. This script writes its version into the three other manifests, changing
 * nothing but the "version" value, and --check exits 1 naming every manifest that disagrees.
 *
 *   node scripts/sync-version.mjs           # write
 *   node scripts/sync-version.mjs --check   # verify (test/version-parity.test.js runs this)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from '../entry-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFESTS = Object.freeze(['.claude-plugin/plugin.json', 'openclaw.plugin.json', 'claude-code/marketplace-entry.json']);
const VERSION_LINE = /^(\s*"version":\s*")([^"]*)(")/m;

/** @returns {{ version: string, drift: { file: string, has: string|null }[] }} */
export function check(root = ROOT) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const drift = [];
  for (const file of MANIFESTS) {
    const has = JSON.parse(readFileSync(join(root, file), 'utf8')).version ?? null;
    if (has !== version) drift.push({ file, has });
  }
  return { version, drift };
}

export function write(root = ROOT) {
  const { version } = check(root);
  for (const file of MANIFESTS) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    if (!VERSION_LINE.test(text)) throw new Error(`${file}: no top-level "version" line to set`);
    writeFileSync(path, text.replace(VERSION_LINE, `$1${version}$3`));
  }
  return check(root);
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const r = process.argv.includes('--check') ? check() : write();
  if (r.drift.length) {
    console.error(`sync-version: package.json is ${r.version}; ${r.drift.map((d) => `${d.file} is ${d.has}`).join(', ')}. Run: node scripts/sync-version.mjs`);
    process.exit(1);
  }
  console.log(`sync-version: OK — package.json and ${MANIFESTS.length} manifests are ${r.version}`);
}
