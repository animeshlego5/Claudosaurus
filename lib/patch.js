/*
 * Claudosaurus — shared patch logic (used by cli.js, install.js, uninstall.js)
 * ------------------------------------------------------------------
 * Backs up the Claude Code extension's webview/index.js once, then
 * appends our payload wrapped in marker comments. Idempotent: install
 * always rebuilds from the pristine backup, so patches never stack.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { findExtensions } = require("./locate");

const START = "/*__CLAUDOSAURUS_START__ (injected by claudosaurus; do not edit) */";
const END = "/*__CLAUDOSAURUS_END__*/";
const OLD_START = "/*__CLAUDE_REX_START__ (injected by claude-rex; do not edit) */";
const OLD_END = "/*__CLAUDE_REX_END__*/";
const PAYLOAD_PATH = path.join(__dirname, "..", "ide-payload.js");
const VERSION = require("../package.json").version;
const VERSION_TOKEN = "__CLAUDOSAURUS_VERSION__";

function log(m) { process.stdout.write(m + "\n"); }

// Stamp the package version into the payload (single source of truth: it lives
// only in package.json; the payload ships a token we replace here at patch time).
function injectVersion(payload) {
  return payload.split(VERSION_TOKEN).join(VERSION);
}

function stripBlock(src) {
  // Strip old block if present
  let s = src.indexOf(OLD_START);
  if (s !== -1) {
    const e = src.indexOf(OLD_END, s);
    if (e === -1) {
      src = src.slice(0, s).replace(/\s+$/, "") + "\n";
    } else {
      src = (src.slice(0, s) + src.slice(e + OLD_END.length)).replace(/\s+$/, "") + "\n";
    }
  }
  // Strip new block if present
  s = src.indexOf(START);
  if (s !== -1) {
    const e = src.indexOf(END, s);
    if (e === -1) {
      src = src.slice(0, s).replace(/\s+$/, "") + "\n";
    } else {
      src = (src.slice(0, s) + src.slice(e + END.length)).replace(/\s+$/, "") + "\n";
    }
  }
  return src;
}

function buildBlock(payload) {
  return "\n" + START + "\n" + payload.replace(/\s+$/, "") + "\n" + END + "\n";
}

function pick(all) {
  const matches = findExtensions();
  return { matches, targets: all ? matches : matches.slice(0, 1) };
}

function install(opts) {
  opts = opts || {};
  const DRY = !!opts.dryRun;

  let payload;
  try {
    payload = injectVersion(fs.readFileSync(PAYLOAD_PATH, "utf8"));
  } catch (e) {
    log("ERROR: cannot read ide-payload.js (" + e.message + ").");
    return 1;
  }

  const { matches, targets } = pick(opts.all);
  if (matches.length === 0) {
    log("No Claude Code extension found — nothing to patch.");
    log("(Looked under .antigravity-ide, .vscode, .cursor, .windsurf, etc.)");
    return 0; // soft success
  }

  log("Found " + matches.length + " Claude Code install(s).");
  if (!opts.all && matches.length > 1) log("Patching the newest only — use --all for every copy.");

  let patched = 0;
  for (const m of targets) {
    log("\n" + m.name + ":");
    if (!m.exists) { log("  ! webview/index.js missing — skipping."); continue; }
    try {
      let pristine;
      if (fs.existsSync(m.backup)) {
        pristine = fs.readFileSync(m.backup, "utf8");
        log("  · using existing backup as pristine base");
      } else {
        pristine = stripBlock(fs.readFileSync(m.target, "utf8"));
        if (DRY) log("  · [dry-run] would back up the original");
        else { fs.writeFileSync(m.backup, pristine, "utf8"); log("  · backed up the original"); }
      }
      const out = stripBlock(pristine) + buildBlock(payload);
      if (DRY) { log("  · [dry-run] would write " + out.length + " bytes"); patched++; continue; }
      fs.writeFileSync(m.target, out, "utf8");
      log("  ✓ patched");
      patched++;
    } catch (e) {
      log("  ! failed: " + e.message);
    }
  }

  if (patched && !DRY) {
    log("\nDone. Reload your editor to play:");
    log("  Command Palette → \"Developer: Reload Window\"");
    log("Then ask Claude anything — the working spinner is now a dino. 🦖");
    log("Re-run after the extension updates. Undo any time: claudosaurus uninstall");
  }
  return 0;
}

function uninstall(opts) {
  opts = opts || {};
  const DRY = !!opts.dryRun;

  const { matches, targets } = pick(opts.all);
  if (matches.length === 0) { log("No Claude Code extension found — nothing to revert."); return 0; }

  let reverted = 0;
  for (const m of targets) {
    log("\n" + m.name + ":");
    try {
      if (fs.existsSync(m.backup)) {
        if (DRY) { log("  · [dry-run] would restore from backup"); reverted++; continue; }
        fs.copyFileSync(m.backup, m.target);
        fs.unlinkSync(m.backup);
        log("  ✓ restored from backup");
        reverted++;
        continue;
      }
      if (!m.exists) { log("  · no index.js and no backup — nothing to do."); continue; }
      const src = fs.readFileSync(m.target, "utf8");
      if (src.indexOf(START) === -1) { log("  · not patched — nothing to do."); continue; }
      if (DRY) { log("  · [dry-run] would strip the injected block"); reverted++; continue; }
      fs.writeFileSync(m.target, stripBlock(src), "utf8");
      log("  ✓ stripped the injected block");
      reverted++;
    } catch (e) {
      log("  ! failed: " + e.message);
    }
  }

  if (reverted && !DRY) log("\nDone. Reload the window to drop the patch.");
  return 0;
}

// Inspect every editor copy without changing anything: is it patched, with
// which version, is a backup present, and is the patch stale vs this package?
function status() {
  const matches = findExtensions();
  if (matches.length === 0) {
    log("No Claude Code extension found.");
    log("(Looked under .antigravity-ide, .vscode, .cursor, .windsurf, etc.)");
    return 0;
  }

  log("claudosaurus v" + VERSION + " — found " + matches.length + " Claude Code install(s):\n");
  for (const m of matches) {
    log(m.name);
    if (!m.exists) { log("  · webview/index.js missing — cannot patch\n"); continue; }

    let src = "";
    try { src = fs.readFileSync(m.target, "utf8"); } catch (e) { log("  ! unreadable: " + e.message + "\n"); continue; }

    const patched = src.indexOf(START) !== -1;
    const hasBackup = fs.existsSync(m.backup);
    if (patched) {
      const block = src.slice(src.indexOf(START));
      // New payloads stamp `var VERSION = "x"`; older ones used `version: "x"`.
      const vm = block.match(/var VERSION = "([^"]+)"/) || block.match(/version:\s*"([^"]+)"/);
      const ver = vm ? vm[1] : "unknown";
      const stale = ver !== "unknown" && ver !== VERSION;
      log("  ✓ patched (v" + ver + ")" + (stale ? "  ⚠ older than v" + VERSION + " — re-run claudosaurus to update" : ""));
    } else {
      log("  · not patched — run claudosaurus to install");
    }
    log("  backup: " + (hasBackup ? "present" : "none") + "\n");
  }
  return 0;
}

module.exports = { install, uninstall, status, stripBlock, injectVersion, START, END, VERSION, VERSION_TOKEN };
