/*
 * Tests for the extension locator: version parsing, newest-first ordering,
 * junk-folder rejection, and the target/backup path shape.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { findExtensions } = require("../lib/locate");

// Build a fake home with the given extension folder names (each gets a
// webview/index.js so it counts as a real, patchable target).
function sandbox(extNames) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudosaurus-locate-"));
  const root = path.join(base, ".vscode", "extensions");
  fs.mkdirSync(root, { recursive: true });
  for (const name of extNames) {
    const wv = path.join(root, name, "webview");
    fs.mkdirSync(wv, { recursive: true });
    fs.writeFileSync(path.join(wv, "index.js"), "// bundle\n", "utf8");
  }

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = base;
  process.env.USERPROFILE = base;

  return {
    cleanup() {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

test("finds matching extensions and ignores unrelated folders", () => {
  const sb = sandbox([
    "anthropic.claude-code-2.1.100-win32-x64",
    "ms-python.python-2024.1.0",
    "not-an-extension"
  ]);
  try {
    const found = findExtensions();
    assert.strictEqual(found.length, 1);
    assert.deepStrictEqual(found[0].version, [2, 1, 100]);
  } finally {
    sb.cleanup();
  }
});

test("orders matches newest-version-first", () => {
  const sb = sandbox([
    "anthropic.claude-code-2.1.9-win32-x64",
    "anthropic.claude-code-2.1.100-win32-x64",
    "anthropic.claude-code-2.2.0-win32-x64",
    "anthropic.claude-code-1.9.99-win32-x64"
  ]);
  try {
    const versions = findExtensions().map((m) => m.version.join("."));
    assert.deepStrictEqual(versions, ["2.2.0", "2.1.100", "2.1.9", "1.9.99"]);
  } finally {
    sb.cleanup();
  }
});

test("numeric (not lexical) version comparison: 2.1.100 > 2.1.9", () => {
  const sb = sandbox([
    "anthropic.claude-code-2.1.9-win32-x64",
    "anthropic.claude-code-2.1.100-win32-x64"
  ]);
  try {
    const versions = findExtensions().map((m) => m.version.join("."));
    assert.deepStrictEqual(versions, ["2.1.100", "2.1.9"]);
  } finally {
    sb.cleanup();
  }
});

test("target points at webview/index.js and backup is the .claudosaurus-bak sibling", () => {
  const sb = sandbox(["anthropic.claude-code-3.0.0-win32-x64"]);
  try {
    const m = findExtensions()[0];
    assert.ok(m.target.endsWith(path.join("webview", "index.js")));
    assert.strictEqual(m.backup, m.target + ".claudosaurus-bak");
    assert.strictEqual(m.exists, true);
  } finally {
    sb.cleanup();
  }
});

test("returns an empty array when no editor is present (fails soft)", () => {
  const sb = sandbox([]);
  try {
    assert.deepStrictEqual(findExtensions(), []);
  } finally {
    sb.cleanup();
  }
});
