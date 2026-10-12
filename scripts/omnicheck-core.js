#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RENDER_SERVICE_ID = process.env.OMNIPAY_RENDER_SERVICE_ID || "srv-d9qcugf10e5c739ect50";
const PUBLIC_STATUS_URL = process.env.OMNIPAY_STATUS_URL || "https://www.omnipay-bj.com/api/status";

let okCount = 0;
let warningCount = 0;
let failCount = 0;

const ok = (message) => { okCount += 1; console.log(`OK   ${message}`); };
const warn = (message) => { warningCount += 1; console.log(`WARN ${message}`); };
const fail = (message) => { failCount += 1; console.log(`FAIL ${message}`); };
const absolute = (relative) => path.join(ROOT, relative);

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0;
}

function checkFile(relative) {
  if (fs.existsSync(absolute(relative))) ok(`Fichier présent : ${relative}`);
  else fail(`Fichier absent : ${relative}`);
}

function checkSyntax(relative) {
  const file = absolute(relative);
  if (!fs.existsSync(file)) return fail(`Syntaxe impossible, fichier absent : ${relative}`);
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) ok(`Syntaxe valide : ${relative}`);
  else {
    fail(`Syntaxe invalide : ${relative}`);
    console.log(String(result.stderr || result.stdout || "").trim());
  }
}

function findDeployObjects(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (typeof value.status === "string" && (value.id || value.commit || value.createdAt)) found.push(value);
  if (Array.isArray(value)) value.forEach((item) => findDeployObjects(item, found));
  else Object.values(value).forEach((item) => findDeployObjects(item, found));
  return found;
}

async function checkRender() {
  console.log("\n[6] RENDER WEB SERVICE");
  console.log(`Service ciblé : ${RENDER_SERVICE_ID}`);

  if (!commandExists("render")) {
    fail("Render CLI absent");
    return;
  }
  ok("Render CLI installé");

  const version = spawnSync("render", ["--version"], { encoding: "utf8" });
  if (version.status === 0) ok(String(version.stdout).trim().split("\n")[0]);
  else warn("Version Render CLI non lisible");

  const deploys = spawnSync(
    "render",
    ["deploys", "list", RENDER_SERVICE_ID, "--output", "json"],
    { cwd: ROOT, encoding: "utf8", timeout: 30000 }
  );

  if (deploys.error?.code === "ETIMEDOUT") {
    fail("Render CLI : délai dépassé");
  } else if (deploys.status !== 0) {
    fail("Impossible de lire les déploiements Render");
    const details = String(deploys.stderr || deploys.stdout || "").trim();
    if (details) console.log(details);
  } else {
    try {
      const parsed = JSON.parse(deploys.stdout);
      const candidates = findDeployObjects(parsed).sort((a, b) => {
        const ad = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bd = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bd - ad;
      });
      const latest = candidates[0];
      if (!latest) {
        warn("Aucun déploiement exploitable dans la réponse Render");
      } else {
        const status = String(latest.status || "unknown").toLowerCase();
        const commit = latest.commit?.id || latest.commitId || "inconnu";
        console.log(`Dernier déploiement : ${status} | commit ${commit}`);
        if (status === "live") ok("Dernier déploiement Render en ligne");
        else if (["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"].includes(status)) {
          warn(`Déploiement Render en cours : ${status}`);
        } else {
          fail(`Dernier déploiement Render non opérationnel : ${status}`);
        }
      }
    } catch (error) {
      fail(`Réponse Render JSON illisible : ${error.message}`);
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(PUBLIC_STATUS_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      ok(`Endpoint public accessible : HTTP ${response.status}`);
      console.log(`API : ${payload.application || "OMNIPAY"} | statut ${payload.status || "réponse reçue"}`);
    } else {
      fail(`Endpoint public en erreur : HTTP ${response.status}`);
    }
  } catch (error) {
    fail(`Endpoint public inaccessible : ${error.message}`);
  }
}

async function main() {
  console.log("\n============================================");
  console.log("OMNICHECK V3 - MULTI-OPERATEURS + RENDER");
  console.log("Lecture seule : aucun paiement, aucun deploy");
  console.log("============================================\n");

  const files = [
    "multi-operator/index.js",
    "multi-operator/config/providerConfig.js",
    "multi-operator/providers/BaseProvider.js",
    "multi-operator/providers/DisabledProvider.js",
    "multi-operator/providers/PayDunyaProvider.js",
    "multi-operator/services/ProviderRegistry.js",
    "multi-operator/services/PaymentOrchestrator.js",
    "multi-operator/tests/paydunya-adapter.test.js",
    "providers/paydunya.js",
  ];

  console.log("[1] FICHIERS");
  files.forEach(checkFile);

  console.log("\n[2] SYNTAXE");
  files.filter((file) => file.endsWith(".js")).forEach(checkSyntax);

  console.log("\n[3] REGISTRE");
  let registry;
  try {
    const modulePath = absolute("multi-operator");
    const multi = require(modulePath);
    registry = multi.registry;
    ok("ProviderRegistry chargé");
    for (const name of ["paydunya", "mtn", "moov", "celtiis"]) {
      const provider = registry.get(name);
      ok(`Provider enregistré : ${name}`);
      if (name !== "paydunya" && provider.enabled) warn(`${name.toUpperCase()} activé`);
    }
    const paydunya = registry.get("paydunya");
    if (paydunya.constructor.name === "PayDunyaProvider") ok("Adaptateur PayDunya actif dans le registre");
    else fail(`Classe PayDunya inattendue : ${paydunya.constructor.name}`);
    if (typeof paydunya.createInvoice === "function" && typeof paydunya.confirmInvoice === "function") {
      ok("Fonctions PayDunya réelles injectées");
    } else fail("Injection PayDunya incomplète");
    console.table(registry.list());
  } catch (error) {
    fail(`Registre indisponible : ${error.message}`);
  }

  console.log("\n[4] CONFIGURATION LOCALE");
  for (const name of ["PAYDUNYA_MASTER_KEY", "PAYDUNYA_PRIVATE_KEY", "PAYDUNYA_PUBLIC_KEY", "PAYDUNYA_TOKEN"]) {
    if (process.env[name]) ok(`Variable présente : ${name}`);
    else warn(`Variable absente localement : ${name}`);
  }
  const mode = String(process.env.PAYDUNYA_MODE || "").toLowerCase();
  if (["test", "live"].includes(mode)) ok(`PAYDUNYA_MODE : ${mode}`);
  else warn("PAYDUNYA_MODE absent localement");

  console.log("\n[5] TEST ADAPTATEUR ISOLE");
  const test = spawnSync(process.execPath, [absolute("multi-operator/tests/paydunya-adapter.test.js")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (test.status === 0 && test.stdout.includes("PAYDUNYA_ADAPTER_TEST_OK")) ok("Adaptateur PayDunya validé sans paiement réel");
  else {
    fail("Test adaptateur PayDunya échoué");
    console.log(String(test.stderr || test.stdout || "").trim());
  }

  await checkRender();

  console.log("\n============================================");
  console.log("RESUME OMNICHECK V3");
  console.log(`OK       : ${okCount}`);
  console.log(`ALERTES  : ${warningCount}`);
  console.log(`ECHECS   : ${failCount}`);
  console.log(`STATUT   : ${failCount ? "ECHEC" : warningCount ? "PRET AVEC ALERTES" : "PRET"}`);
  console.log("============================================\n");
  process.exitCode = failCount ? 1 : 0;
}

main().catch((error) => {
  fail(`Erreur inattendue : ${error.message}`);
  process.exitCode = 1;
});
