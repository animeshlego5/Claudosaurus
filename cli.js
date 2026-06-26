#!/usr/bin/env node
/*
 * Claudosaurus CLI — single entry point.
 *   claudosaurus            patch the newest Claude Code extension (default)
 *   claudosaurus install    same as above
 *   claudosaurus uninstall  restore the original
 *   claudosaurus --all      apply to every editor copy found
 *   claudosaurus --dry-run  preview only, change nothing
 *   claudosaurus --version | --help
 */
"use strict";

const { install, uninstall, status } = require("./lib/patch");

const argv = process.argv.slice(2);
const flag = function (name) { return argv.indexOf(name) !== -1; };
const cmd = argv.find(function (a) { return a[0] !== "-"; }) || "install";
const opts = { all: flag("--all"), dryRun: flag("--dry-run") };

function help() {
  process.stdout.write([
    "claudosaurus — turn the Claude Code \"thinking\" spinner into a dino game 🦖",
    "",
    "Usage:",
    "  claudosaurus [install]      patch the newest Claude Code extension",
    "  claudosaurus uninstall      restore the original bundle",
    "  claudosaurus status         show which editors are found / patched",
    "",
    "Options:",
    "  --all                     apply to every editor copy found (VS Code, Cursor, Antigravity, …)",
    "  --dry-run                 show what would happen, change nothing",
    "  -h, --help                this help",
    "  -v, --version             print version",
    "",
    "After patching, reload your editor: Command Palette → \"Developer: Reload Window\".",
    "The patch is replaced when the extension updates — just run claudosaurus again.",
    "",
    "In-game: press ? for settings (theme, speed/jump presets + fine-tune sliders,",
    "sound, day/night, clouds, birds, free-play). Everything persists locally.",
    ""
  ].join("\n"));
}

if (flag("-h") || flag("--help") || cmd === "help") { help(); process.exit(0); }
if (flag("-v") || flag("--version")) { console.log(require("./package.json").version); process.exit(0); }

let code = 0;
if (cmd === "uninstall" || cmd === "unpatch" || cmd === "remove") code = uninstall(opts);
else if (cmd === "install" || cmd === "patch") code = install(opts);
else if (cmd === "status" || cmd === "list" || cmd === "doctor") code = status(opts);
else { process.stdout.write("Unknown command: " + cmd + "\n\n"); help(); code = 1; }

process.exit(code || 0);
