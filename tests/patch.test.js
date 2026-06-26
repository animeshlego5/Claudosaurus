/*
 * Tests for the patch pipeline — the part with real invariants:
 *   - back up the pristine bundle exactly once
 *   - injecting never stacks (idempotent re-install)
 *   - the version token is replaced from package.json
 *   - uninstall restores byte-for-byte and removes the backup
 *
 * Uses a sandboxed fake home so it never touches a real editor install.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const patch = require("../lib/patch");
const pkg = require("../package.json");

const { stripBlock, injectVersion, install, uninstall, status, START, END, VERSION_TOKEN } = patch;

const ORIGINAL = "// claude code webview bundle\nconsole.log('original');\n";

// Swallow the CLI's stdout chatter during a call so test output stays clean.
function quiet(fn) {
  const orig = process.stdout.write;
  process.stdout.write = function () { return true; };
  try { return fn(); } finally { process.stdout.write = orig; }
}

// Capture stdout produced during a call (used to assert on `status` output).
function capture(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = function (s) { out += s; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return out;
}

// Build a throwaway home with one fake Claude Code extension; redirect
// os.homedir() at it by overriding HOME/USERPROFILE. Returns paths + cleanup.
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudosaurus-test-"));
  const webview = path.join(base, ".vscode", "extensions", "anthropic.claude-code-9.9.9-test", "webview");
  fs.mkdirSync(webview, { recursive: true });
  const target = path.join(webview, "index.js");
  fs.writeFileSync(target, ORIGINAL, "utf8");

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = base;
  process.env.USERPROFILE = base;

  return {
    target,
    backup: target + ".claudosaurus-bak",
    cleanup() {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("stripBlock leaves marker-free source untouched", () => {
  assert.strictEqual(stripBlock(ORIGINAL), ORIGINAL);
});

test("stripBlock removes a well-formed injected block", () => {
  const withBlock = ORIGINAL + "\n" + START + "\npayload();\n" + END + "\n";
  const out = stripBlock(withBlock);
  assert.ok(!out.includes(START));
  assert.ok(!out.includes(END));
  assert.ok(out.startsWith("// claude code webview bundle"));
});

test("stripBlock tolerates a START with no END (truncates to it)", () => {
  const broken = ORIGINAL + "\n" + START + "\npayload(); // never closed";
  const out = stripBlock(broken);
  assert.ok(!out.includes(START));
});

test("injectVersion replaces every token with the package version", () => {
  const src = "a " + VERSION_TOKEN + " b " + VERSION_TOKEN;
  const out = injectVersion(src);
  assert.ok(!out.includes(VERSION_TOKEN));
  assert.strictEqual(count(out, pkg.version), 2);
});

test("injectVersion is a no-op when the token is absent", () => {
  assert.strictEqual(injectVersion("no token here"), "no token here");
});

test("install backs up once, injects a single block, and stamps the version", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false }));

    assert.ok(fs.existsSync(sb.backup), "backup created");
    assert.strictEqual(fs.readFileSync(sb.backup, "utf8"), ORIGINAL, "backup is pristine");

    const out = fs.readFileSync(sb.target, "utf8");
    assert.ok(out.startsWith(ORIGINAL), "original content preserved before the block");
    assert.strictEqual(count(out, START), 1, "exactly one START marker");
    assert.strictEqual(count(out, END), 1, "exactly one END marker");
    assert.ok(!out.includes(VERSION_TOKEN), "version token replaced");
    assert.ok(out.includes(pkg.version), "package version present");
  } finally {
    sb.cleanup();
  }
});

test("re-installing does not stack the patch (idempotent)", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false }));
    const once = fs.readFileSync(sb.target, "utf8");
    quiet(() => install({ all: false }));
    const twice = fs.readFileSync(sb.target, "utf8");

    assert.strictEqual(once, twice, "second install is byte-identical");
    assert.strictEqual(count(twice, START), 1, "still one START marker");
    assert.strictEqual(fs.readFileSync(sb.backup, "utf8"), ORIGINAL, "backup untouched");
  } finally {
    sb.cleanup();
  }
});

test("uninstall restores the original byte-for-byte and removes the backup", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false }));
    quiet(() => uninstall({ all: false }));

    assert.strictEqual(fs.readFileSync(sb.target, "utf8"), ORIGINAL, "target restored exactly");
    assert.ok(!fs.existsSync(sb.backup), "backup removed");
  } finally {
    sb.cleanup();
  }
});

test("uninstall twice is a harmless no-op", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false }));
    quiet(() => uninstall({ all: false }));
    quiet(() => uninstall({ all: false }));
    assert.strictEqual(fs.readFileSync(sb.target, "utf8"), ORIGINAL);
  } finally {
    sb.cleanup();
  }
});

test("status reports an unpatched install", () => {
  const sb = sandbox();
  try {
    const out = capture(() => status({}));
    assert.match(out, /not patched/);
  } finally {
    sb.cleanup();
  }
});

test("status reports a patched install with version and backup", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false }));
    const out = capture(() => status({}));
    assert.match(out, /patched \(v/);
    assert.match(out, new RegExp(pkg.version.replace(/\./g, "\\.")));
    assert.match(out, /backup: present/);
  } finally {
    sb.cleanup();
  }
});

test("dry-run install changes nothing on disk", () => {
  const sb = sandbox();
  try {
    quiet(() => install({ all: false, dryRun: true }));
    assert.ok(!fs.existsSync(sb.backup), "no backup written in dry-run");
    assert.strictEqual(fs.readFileSync(sb.target, "utf8"), ORIGINAL, "target unchanged in dry-run");
  } finally {
    sb.cleanup();
  }
});
