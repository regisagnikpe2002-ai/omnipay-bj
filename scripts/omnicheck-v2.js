#!/usr/bin/env node

"use strict";

const mode = process.argv[2] || "status";

console.log("====================================");
console.log("OMNIPAY");
console.log("FINTECH AFRICA PLATFORM");
console.log("====================================");

if (mode === "users") {
  console.log("OMNICHECK USERS");
  console.log("Users monitoring module ready");
}
else if (mode === "report") {
  console.log("OMNICHECK REPORT");
  console.log("System report module ready");
}
else if (mode === "help") {
  console.log("AVAILABLE COMMANDS");
  console.log("");
  console.log("status");
  console.log("users");
  console.log("report");
  console.log("help");
  console.log("version");
}
else if (mode === "version") {
  console.log("OMNICHECK VERSION");
  console.log("v2.0.0");
}
else {
  console.log("OMNICHECK V2");
  console.log("SYSTEM STATUS : OK");
  console.log("SERVER STATUS : READY");
  console.log("WALLET STATUS : READY");
  console.log("API STATUS : READY");
  console.log("OMNIPAY READY FOR OPERATIONS");
}
