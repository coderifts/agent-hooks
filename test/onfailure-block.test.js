// The hooks page says a PreToolUse command timeout does not block the tool call
// unless onFailure is "block". Exit 2 already blocks. This test locks the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FILES = ["hooks/hooks.json", "claude-code/settings.snippet.json"];

test("both shipped PreToolUse command hooks set onFailure block", () => {
  for (const file of FILES) {
    const doc = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    const group = doc.hooks.PreToolUse[0];
    assert.equal(group.hooks.length, 1, file);
    assert.equal(group.hooks[0].onFailure, "block", file);
    assert.equal(group.hooks[0].timeout, 8, file);
  }
});
