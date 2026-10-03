/**
 * contract-write.mjs is not authored here (0.3.0, 2026-10-03). It is a byte copy of
 * @coderifts/contract-path's contract-write.mjs, the one decision function this hook,
 * `coderifts claude-hook` and the CodeRifts mod share, written by coderifts-app's
 * scripts/generate-contract-write-copies.js together with contract-write.sha256.
 *
 * Held here: the copy is the bytes that generator wrote (a hand edit changes the digest), and it
 * still says where its source is. The app side's `--check` compares the copy with the source itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("contract-write.mjs is the generated copy", () => {
  it("its sha256 is the one the generator recorded", () => {
    const [recorded, name] = read("contract-write.sha256").trim().split(/\s+/);
    assert.equal(name, "contract-write.mjs");
    const actual = createHash("sha256").update(read("contract-write.mjs")).digest("hex");
    assert.equal(actual, recorded, "contract-write.mjs differs from what generate-contract-write-copies.js wrote; regenerate it in coderifts-app instead of editing the copy");
  });

  it("it names its canonical source", () => {
    assert.match(read("contract-write.mjs"), /CANONICAL SOURCE: coderifts-app packages\/contract-path\/contract-write\.mjs/);
  });

  it("gate.js and the Claude adapter import it, and keep no path list of their own", () => {
    for (const f of ["gate.js", "claude-code/hook.mjs"]) {
      const src = read(f);
      assert.match(src, /from "\.\.?\/contract-write\.mjs"/, `${f} does not import contract-write.mjs`);
      assert.doesNotMatch(src, /openapi\[\^\/\]\*\\\.\(ya\?ml\|json\)/, `${f} carries a path regex of its own again`);
    }
  });
});
