#!/usr/bin/env node
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const checks = [path.join(__dirname, "omnicheck-core.js"), path.join(root, "commission-ledger", "scripts", "commission-omnicheck.js")];
let failed = false;
for (const check of checks) { const result = spawnSync(process.execPath, [check], { cwd: root, stdio: "inherit" }); if (result.status !== 0) failed = true; }
process.exitCode = failed ? 1 : 0;
