/**
 * The Claude Code hook entry runs when the invoked path contains a symlink.
 *
 * Packed installs, not the checkout. Case (a) is the real path of hook.mjs.
 * Cases (b)–(e) must print the same decision. Published 0.3.4 is the negative
 * control: a directory symlink and a pnpm-style link never enter main().
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invokedDirectly } from "../entry-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_URL = pathToFileURL(join(ROOT, "claude-code", "hook.mjs")).href;
const SYNC_URL = pathToFileURL(join(ROOT, "scripts", "sync-version.mjs")).href;

const WRITE = JSON.stringify({
  session_id: "s",
  cwd: "/work",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: {
    file_path: "api/openapi.yaml",
    content: "openapi: 3.0.0\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /users: {}\n",
  },
  tool_use_id: "toolu_measure",
});
const BAD = "not-json";

const SETTINGS_CMD = {
  command: "node",
  args: ["${CLAUDE_PROJECT_DIR}/node_modules/@coderifts/agent-hooks/claude-code/hook.mjs"],
};
const HOOKS_CMD = {
  command: "node",
  args: ["${CLAUDE_PLUGIN_ROOT}/claude-code/hook.mjs"],
};

function childEnv() {
  const env = { ...process.env };
  for (const key of [
    "CODERIFTS_API_KEY",
    "CODERIFTS_ADMIN_KEY",
    "CODERIFTS_ENDPOINT",
    "CODERIFTS_TIMEOUT_MS",
    "CODERIFTS_OPERATION",
  ]) {
    delete env[key];
  }
  return env;
}

function runNode(args, { cwd, stdin }) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    input: stdin,
    encoding: "utf8",
    timeout: 25000,
    env: childEnv(),
  });
  assert.equal(r.error, undefined, r.error && r.error.message);
  return { exit: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function installPacked(dir, packArgs, packCwd) {
  mkdirSync(dir, { recursive: true });
  const packOut = execFileSync("npm", ["pack", ...packArgs, "--pack-destination", dir], {
    cwd: packCwd,
    encoding: "utf8",
    env: childEnv(),
  });
  const tgz = join(dir, packOut.trim().split("\n").pop());
  const app = join(dir, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pack-consumer", private: true }));
  execFileSync("npm", ["install", tgz, "--ignore-scripts"], {
    cwd: app,
    encoding: "utf8",
    env: childEnv(),
  });
  const pkg = realpathSync(join(app, "node_modules", "@coderifts", "agent-hooks"));
  const dirLink = join(dir, "dir-link");
  const projectLink = join(dir, "project-link");
  const pluginLink = join(dir, "plugin-link");
  symlinkSync(pkg, dirLink);
  symlinkSync(app, projectLink);
  symlinkSync(pkg, pluginLink);
  const pnpmRoot = join(dir, "pnpm-app");
  const store = join(
    pnpmRoot,
    "node_modules",
    ".pnpm",
    "@coderifts+agent-hooks@store",
    "node_modules",
    "@coderifts",
    "agent-hooks",
  );
  mkdirSync(dirname(store), { recursive: true });
  cpSync(pkg, store, { recursive: true });
  mkdirSync(join(pnpmRoot, "node_modules", "@coderifts"), { recursive: true });
  const pnpmLink = join(pnpmRoot, "node_modules", "@coderifts", "agent-hooks");
  symlinkSync(join("..", ".pnpm", "@coderifts+agent-hooks@store", "node_modules", "@coderifts", "agent-hooks"), pnpmLink);
  assert.equal(lstatSync(pnpmLink).isSymbolicLink(), true);
  assert.equal(realpathSync(pnpmLink), realpathSync(store));
  return { app, pkg, dirLink, projectLink, pluginLink, pnpmLink };
}

function invocations(layout) {
  const settings = JSON.parse(readFileSync(join(layout.pkg, "claude-code", "settings.snippet.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(layout.pkg, "hooks", "hooks.json"), "utf8"));
  const settingsHook = settings.hooks.PreToolUse[0].hooks[0];
  const hooksHook = hooks.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual({ command: settingsHook.command, args: settingsHook.args }, SETTINGS_CMD);
  assert.deepEqual({ command: hooksHook.command, args: hooksHook.args }, HOOKS_CMD);
  return {
    a: { args: [realpathSync(join(layout.pkg, "claude-code", "hook.mjs"))], cwd: layout.pkg },
    b: { args: [join(layout.dirLink, "claude-code", "hook.mjs")], cwd: layout.pkg },
    c: { args: [join(layout.pnpmLink, "claude-code", "hook.mjs")], cwd: layout.app },
    d: { args: ["claude-code/hook.mjs"], cwd: layout.pkg },
    eSettings: {
      args: [settingsHook.args[0].replace("${CLAUDE_PROJECT_DIR}", layout.projectLink)],
      cwd: layout.app,
    },
    eHooks: {
      args: [hooksHook.args[0].replace("${CLAUDE_PLUGIN_ROOT}", layout.pluginLink)],
      cwd: layout.pkg,
    },
  };
}

function probe(layout, stdin) {
  const out = {};
  for (const [name, spec] of Object.entries(invocations(layout))) {
    out[name] = runNode(spec.args, { cwd: spec.cwd, stdin });
  }
  return out;
}

describe("entry check", () => {
  it("runs when it cannot tell, and does not run for a different file", () => {
    assert.equal(invokedDirectly(undefined, HOOK_URL), true);
    assert.equal(invokedDirectly("", HOOK_URL), true);
    assert.equal(invokedDirectly(join(ROOT, "claude-code", "hook.mjs"), undefined), true);
    assert.equal(invokedDirectly("/no/such/hook.mjs", HOOK_URL), true);
    assert.equal(invokedDirectly(join(ROOT, "index.js"), HOOK_URL), false);
    assert.equal(invokedDirectly(join(ROOT, "claude-code", "hook.mjs"), HOOK_URL), true);

    const linkDir = mkdtempSync(join(tmpdir(), "ah-guard-link-"));
    try {
      const link = join(linkDir, "hook.mjs");
      symlinkSync(join(ROOT, "claude-code", "hook.mjs"), link);
      assert.equal(invokedDirectly(link, HOOK_URL), true);
      assert.notEqual(link, realpathSync(link));
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("imports hook.mjs without entering main", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-guard-import-"));
    try {
      const importer = join(dir, "importer.mjs");
      writeFileSync(
        importer,
        `import { runClaudeHook } from ${JSON.stringify(HOOK_URL)};\nconsole.log(typeof runClaudeHook);\n`,
      );
      const out = runNode([importer], { cwd: dir, stdin: "" });
      assert.equal(out.exit, 0);
      assert.equal(out.stdout, "function\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs sync-version.mjs through a symlink to the script", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-sync-link-"));
    try {
      const link = join(dir, "sync-version.mjs");
      symlinkSync(join(ROOT, "scripts", "sync-version.mjs"), link);
      const out = runNode([link, "--check"], { cwd: ROOT, stdin: "" });
      assert.equal(out.exit, 0);
      assert.match(out.stdout, /^sync-version: OK — package\.json and 3 manifests are \d+\.\d+\.\d+\n$/);
      assert.equal(invokedDirectly(link, SYNC_URL), true);
      assert.equal(invokedDirectly(join(ROOT, "package.json"), SYNC_URL), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("packed hook entry", { timeout: 180000 }, () => {
  let work;
  let fixed;
  let published;

  before(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "ah-symlink-entry-")));
    fixed = installPacked(join(work, "fixed"), [], ROOT);
    published = installPacked(join(work, "published"), ["@coderifts/agent-hooks@0.3.4"], work);
    assert.equal(JSON.parse(readFileSync(join(published.pkg, "package.json"), "utf8")).version, "0.3.4");
    assert.equal(JSON.parse(readFileSync(join(fixed.pkg, "package.json"), "utf8")).version, "0.3.5");
  });

  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("cases (a)–(e) reach main and match the real-path decision", () => {
    for (const stdin of [BAD, WRITE]) {
      const got = probe(fixed, stdin);
      for (const name of ["b", "c", "d", "eSettings", "eHooks"]) {
        assert.deepEqual(got[name], got.a, `${name} differed from the real path`);
      }
      assert.notDeepEqual(got.a, { exit: 0, stdout: "", stderr: "" });
    }
    const bad = probe(fixed, BAD);
    assert.equal(bad.a.exit, 2);
    assert.match(bad.a.stderr, /stdin was not JSON/);
    const write = probe(fixed, WRITE);
    assert.equal(write.a.exit, 0);
    assert.match(write.a.stdout, /"permissionDecision":/);
  });

  it("published 0.3.4 stays silent on a directory symlink and a pnpm link", () => {
    const bad = probe(published, BAD);
    assert.equal(bad.a.exit, 2);
    assert.match(bad.a.stderr, /stdin was not JSON/);
    assert.deepEqual(bad.b, { exit: 0, stdout: "", stderr: "" });
    assert.deepEqual(bad.c, { exit: 0, stdout: "", stderr: "" });

    const write = probe(published, WRITE);
    assert.equal(write.a.exit, 0);
    assert.match(write.a.stdout, /"permissionDecision":"ask"/);
    assert.deepEqual(write.b, { exit: 0, stdout: "", stderr: "" });
    assert.deepEqual(write.c, { exit: 0, stdout: "", stderr: "" });
  });
});
