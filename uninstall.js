#!/usr/bin/env node
/* Thin wrapper — see lib/patch.js. Equivalent to: claudosaurus uninstall */
"use strict";
const { uninstall } = require("./lib/patch");
const a = process.argv.slice(2);
process.stdout.write("Claudosaurus uninstaller\n");
process.exit(uninstall({ all: a.indexOf("--all") !== -1, dryRun: a.indexOf("--dry-run") !== -1 }) || 0);
