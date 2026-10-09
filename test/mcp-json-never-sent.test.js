/**
 * P65d (2026-10-09) — a plain mcp.json that is both an MCP client configuration and a tool manifest
 * ('mixed'), or that does not parse ('unparseable'), is never sent and never passed: on the Claude Code
 * file tools (contract-write's decideToolCall) and on the OpenClaw tool shapes, the gate asks with
 * contract-write's sentence. The vectors are coderifts-app's shared file, copied here by
 * generate-contract-write-copies.js (test/fixtures/mcp-json-vectors.json; do not edit the copy).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGate } from "../gate.js";
import * as CW from "../contract-write.mjs";

const { token: TOKEN, vectors: V } = JSON.parse(readFileSync(new URL("./fixtures/mcp-json-vectors.json", import.meta.url), "utf8"));
const HELD = new Set(["mixed", "unparseable"]);

function gate(disk) {
  const sent = [];
  const g = createGate({ apiKey: "k" }, {
    askCodeRifts: async (req) => { sent.push(JSON.stringify(req)); return { kind: "ok", body: { execution_action: "CONTINUE" } }; },
    readFile: async () => { if (disk == null) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return disk; },
  });
  return { g, sent };
}

describe("P65d — the shared vectors, both paths", () => {
  for (const v of V) {
    it(`${v.id}: kind ${v.kind}`, () => assert.equal(CW.mcpJsonKind(v.text), v.kind));
    for (const [label, event] of [
      ["Claude Code Write", { toolName: "Write", params: { file_path: "mcp.json", content: v.text }, cwd: "/w" }],
      ["OpenClaw write_file", { toolName: "write_file", params: { path: "mcp.json", content: v.text } }],
    ]) {
      it(`${v.id}: ${label} of it`, async () => {
        const { g, sent } = gate(null);
        const out = await g(event);
        // The no-send assertion first: on contract-write 1.3.0 this is the one that fails (the negative control).
        if (v.carries_token) assert.ok(!sent.some((s) => s.includes(TOKEN)), "the probe token was sent");
        if (HELD.has(v.kind)) {
          assert.ok(out && out.requireApproval, JSON.stringify(out));
          assert.ok(JSON.stringify(out).includes(CW.heldWhy("mcp.json", v.kind).slice(0, 60)));
          assert.equal(sent.length, 0);
        } else if (v.kind === "client_config") {
          assert.equal(out, undefined);
          assert.equal(sent.length, 0);
        } else {
          assert.equal(sent.length, 1);
        }
      });
    }
  }
});
