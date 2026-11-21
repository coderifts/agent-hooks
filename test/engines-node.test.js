// gate.js calls global fetch. On the Node.js v18 globals page, fetch is no longer
// behind --experimental-fetch as of v18.0.0:
// https://nodejs.org/docs/latest-v18.x/api/globals.html#fetch
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package.json engines.node is the fetch floor", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.engines, "engines");
  assert.equal(pkg.engines.node, ">=18.0.0");
});
