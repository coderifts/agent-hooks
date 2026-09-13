/**
 * Pack-then-install proof. In-repo tests import from the checkout, so they cannot see a
 * `files` allowlist that dropped a relative import (0.1.0 shipped without gate.js).
 *
 * This file packs the package, installs THAT tarball into an empty tree, then:
 *   1. asserts every `from "./…"` in the packed entry resolves to a file in the tarball
 *   2. loads the entry with a stub `openclaw` peer (the host is not bundled)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function relativeSpecifiers(source) {
  const found = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(source))) found.push(m[1]);
  return found;
}

describe("the packed tarball, not the checkout", () => {
  let work;
  let pkgRoot;
  let appRoot;

  before(() => {
    work = mkdtempSync(join(tmpdir(), "coderifts-openclaw-pack-"));
    const packOut = execFileSync("npm", ["pack", "--pack-destination", work], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const tgzName = packOut.trim().split("\n").pop();
    const tgz = join(work, tgzName);
    assert.ok(existsSync(tgz), `npm pack did not write ${tgz}`);

    appRoot = join(work, "app");
    mkdirSync(appRoot);
    writeFileSync(
      join(appRoot, "package.json"),
      JSON.stringify({ name: "pack-consumer", private: true, type: "module" }),
    );
    execFileSync("npm", ["install", tgz, "--ignore-scripts"], {
      cwd: appRoot,
      encoding: "utf8",
    });
    pkgRoot = join(appRoot, "node_modules", "@coderifts", "openclaw-plugin");
  });

  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("ships every relative import of index.js (the 0.1.0 hole)", () => {
    const entry = readFileSync(join(pkgRoot, "index.js"), "utf8");
    const rels = relativeSpecifiers(entry);
    assert.ok(rels.includes("./gate.js"), "index.js must import ./gate.js");
    for (const rel of rels) {
      assert.ok(
        existsSync(join(pkgRoot, rel)),
        `packed tarball is missing ${rel} (imported by index.js). ` +
          `0.1.0 failed here because "files" omitted gate.js.`,
      );
    }
  });

  it("loads the packed entry once a stub openclaw peer is present", async () => {
    const stubRoot = join(appRoot, "node_modules", "openclaw");
    mkdirSync(stubRoot, { recursive: true });
    writeFileSync(
      join(stubRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "0.0.0-stub",
        type: "module",
        exports: {
          "./plugin-sdk/plugin-entry": "./plugin-entry.js",
        },
      }),
    );
    writeFileSync(
      join(stubRoot, "plugin-entry.js"),
      "export function definePluginEntry(def) { return def; }\n",
    );

    const mod = await import(pathToFileURL(join(pkgRoot, "index.js")).href);
    assert.equal(mod.default.id, "coderifts-contract-gate");
    assert.equal(typeof mod.default.register, "function");
  });
});
