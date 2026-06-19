#!/usr/bin/env node
/*
 * Claude-Rex CLI — single entry point.
 *   claude-rex            patch the newest Claude Code extension (default)
 *   claude-rex install    same as above
 *   claude-rex uninstall  restore the original
 *   claude-rex --all      apply to every editor copy found
 *   claude-rex --dry-run  preview only, change nothing
 *   claude-rex --version | --help
 */
"use strict";

const { install, uninstall } = require("./lib/patch");

const argv = process.argv.slice(2);
const flag = function (name) { return argv.indexOf(name) !== -1; };
const cmd = argv.find(function (a) { return a[0] !== "-"; }) || "install";
const opts = { all: flag("--all"), dryRun: flag("--dry-run") };

function help() {
  process.stdout.write([
    "claude-rex — turn the Claude Code \"thinking\" spinner into a dino game 🦖",
    "",
    "Usage:",
    "  claude-rex [install]      patch the newest Claude Code extension",
    "  claude-rex uninstall      restore the original bundle",
    "",
    "Options:",
    "  --all                     apply to every editor copy found (VS Code, Cursor, Antigravity, …)",
    "  --dry-run                 show what would happen, change nothing",
    "  -h, --help                this help",
    "  -v, --version             print version",
    "",
    "After patching, reload your editor: Command Palette → \"Developer: Reload Window\".",
    "The patch is replaced when the extension updates — just run claude-rex again.",
    ""
  ].join("\n"));
}

if (flag("-h") || flag("--help") || cmd === "help") { help(); process.exit(0); }
if (flag("-v") || flag("--version")) { console.log(require("./package.json").version); process.exit(0); }

let code = 0;
if (cmd === "uninstall" || cmd === "unpatch" || cmd === "remove") code = uninstall(opts);
else if (cmd === "install" || cmd === "patch") code = install(opts);
else { process.stdout.write("Unknown command: " + cmd + "\n\n"); help(); code = 1; }

process.exit(code || 0);
