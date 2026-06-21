/*
 * Claudosaurus — extension locator (shared by install.js / uninstall.js)
 * ------------------------------------------------------------------
 * Finds the installed Claude Code extension across the editors that
 * ship it (Antigravity, VS Code, VS Code Insiders, Cursor) and on any
 * platform, then returns the patch target (webview/index.js).
 *
 * No dependencies. Fails soft: returns [] when nothing is found so the
 * caller can skip gracefully instead of crashing.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Editor extension roots, relative to the user's home directory.
const EXTENSION_ROOTS = [
  ".antigravity-ide/extensions",
  ".antigravity/extensions",
  ".vscode/extensions",
  ".vscode-insiders/extensions",
  ".vscode-oss/extensions",
  ".cursor/extensions",
  ".windsurf/extensions"
];

// Extension folders look like: anthropic.claude-code-2.1.183-win32-x64
const EXT_DIR_RE = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/i;

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function parseVersion(name) {
  const m = name.match(EXT_DIR_RE);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Returns an array of matches, newest version first:
 *   { dir, root, version: [maj,min,patch], target, backup, exists }
 * `target`  = absolute path to webview/index.js
 * `backup`  = absolute path to the .bak we create/restore
 * `exists`  = whether the target file is actually present
 */
function findExtensions() {
  const home = os.homedir();
  const matches = [];

  for (const rel of EXTENSION_ROOTS) {
    const root = path.join(home, rel);
    for (const entry of safeReadDir(root)) {
      if (!entry.isDirectory()) continue;
      const version = parseVersion(entry.name);
      if (!version) continue;

      const dir = path.join(root, entry.name);
      const target = path.join(dir, "webview", "index.js");
      matches.push({
        dir,
        root,
        name: entry.name,
        version,
        target,
        backup: fileExists(target + ".claudosaurus-bak")
          ? target + ".claudosaurus-bak"
          : (fileExists(target + ".claude-rex-bak") ? target + ".claude-rex-bak" : target + ".claudosaurus-bak"),
        exists: fileExists(target)
      });
    }
  }

  matches.sort((a, b) => compareVersions(b.version, a.version));
  return matches;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

module.exports = { findExtensions, EXTENSION_ROOTS };
