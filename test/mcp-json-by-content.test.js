/**
 * P65c (2026-10-07) — a plain `mcp.json` is decided by its content (contract-write 1.3.0), on every path
 * this package has: the Claude Code file tools (contract-write's decideToolCall) and the OpenClaw tool
 * shapes (`write_file` …, which build their own before/after).
 *
 * A client configuration (mcpServers / servers, no tools) is never sent; a manifest (tools) is gated;
 * a manifest turned into a client configuration is gated as the manifest removed, without the client side.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGate, classifyPath } from "../gate.js";

const TOKEN = "ghp_P65cHOOKS000000000000000000000000000000";
const CLIENT = JSON.stringify({ mcpServers: { gh: { command: "npx", env: { GITHUB_TOKEN: TOKEN } } } }, null, 2);
const MANIFEST = JSON.stringify({ name: "x", tools: [{ name: "a" }, { name: "b" }] }, null, 2);
const MANIFEST_MINUS = JSON.stringify({ name: "x", tools: [{ name: "a" }] }, null, 2);

function gate(disk) {
  const sent = [];
  const g = createGate({ apiKey: "k" }, {
    askCodeRifts: async (req) => { sent.push(JSON.stringify(req)); return { kind: "ok", body: { execution_action: "CONTINUE" } }; },
    readFile: async () => { if (disk == null) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return disk; },
  });
  return { g, sent };
}

describe("a plain mcp.json, decided by content", () => {
  it("is a candidate by name; the by-name client configurations are not", () => {
    assert.equal(classifyPath("mcp.json"), "mcp_manifest");
    assert.equal(classifyPath(".mcp.json"), null);
    assert.equal(classifyPath(".cursor/mcp.json"), null);
  });

  for (const [label, event] of [
    ["Claude Code Write", { toolName: "Write", params: { file_path: "mcp.json", content: CLIENT }, cwd: "/w" }],
    ["OpenClaw write_file", { toolName: "write_file", params: { path: "mcp.json", content: CLIENT } }],
  ]) {
    it(`${label} of a client configuration: passes, nothing sent`, async () => {
      const { g, sent } = gate(CLIENT);
      assert.equal(await g(event), undefined);
      assert.equal(sent.length, 0);
    });
  }

  for (const [label, event] of [
    ["Claude Code Write", { toolName: "Write", params: { file_path: "mcp.json", content: MANIFEST_MINUS }, cwd: "/w" }],
    ["OpenClaw write_file", { toolName: "write_file", params: { path: "mcp.json", content: MANIFEST_MINUS } }],
  ]) {
    it(`${label} of a manifest (tools): gated`, async () => {
      const { g, sent } = gate(MANIFEST);
      await g(event);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].includes("mcp_manifest"));
    });
  }

  for (const [label, event] of [
    ["Claude Code Write", { toolName: "Write", params: { file_path: "mcp.json", content: CLIENT }, cwd: "/w" }],
    ["OpenClaw write_file", { toolName: "write_file", params: { path: "mcp.json", content: CLIENT } }],
  ]) {
    it(`${label}: a manifest turned into a client configuration is gated as removed, the token never sent`, async () => {
      const { g, sent } = gate(MANIFEST);
      await g(event);
      assert.equal(sent.length, 1);
      assert.ok(!sent[0].includes(TOKEN));
      assert.equal(JSON.parse(sent[0]).artifact.after, "");
    });
  }
});
