#!/usr/bin/env node
/* Thin wrapper — see lib/patch.js. Equivalent to: claude-rex install */
"use strict";
const { install } = require("./lib/patch");
const a = process.argv.slice(2);
process.stdout.write("Claude-Rex installer\n");
process.exit(install({ all: a.indexOf("--all") !== -1, dryRun: a.indexOf("--dry-run") !== -1 }) || 0);
