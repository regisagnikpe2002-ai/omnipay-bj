"use strict";

/**
 * OMNIPAY — server.js (V2.0)
 * Ce fichier ne touche PAS à la base de données : aucune migration, aucune
 * suppression. Clients, transactions et commissions restent intacts.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

// Render est derrière un proxy : nécessaire pour lire la vraie IP du client.
app.set("trust proxy", 1);

// =========================
// Middlewares
// =========================

app.use(cors());

// rawBody conservé : nécessaire à la vérification des webhooks (Binance Pay, PayDunya).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// =========================
// Limitation de débit (protège connexion et envoi d'OTP)
// Seuils volontairement larges : beaucoup d'utilisateurs mobiles partagent la même IP.
// =========================

let rateLimit = null;
try {
  rateLimit = require("express-rate-limit").rateLimit;
} catch (err) {
  console.warn("express-rate-limit indisponible :", err.message);
}

function limiter(max, message) {
  if (!rateLimit) return (req, res, next) => next();
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });
}

app.use("/auth/login", limiter(100, "Trop de tentatives de connexion. Réessayez dans quelques minutes."));
app.use("/auth/register", limiter(60, "Trop de tentatives d'inscription. Réessayez dans quelques minutes."));
app.use("/api/id/lookup", limiter(120, "Trop de recherches. Réessayez dans quelques minutes."));
app.use("/api/email-otp/request", limiter(30, "Trop de demandes de code. Réessayez dans quelques minutes."));

// =========================
// Fichiers statiques (dossier public/)
// =========================

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// =========================
// Santé et statut
// =========================

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    application: "OMNIPAY",
    status: "ONLINE",
    version: "2.0",
    message: "Votre quotidien financier tout-en-un",
  });
});

// =========================
// Routes (chargées avec un message d'erreur explicite si l'une échoue)
// =========================

function mount(urlPath, modulePath, label) {
  try {
    app.use(urlPath, require(modulePath));
    console.log(`[routes] ${label} chargées (${urlPath})`);
  } catch (err) {
    console.error(`[routes] ${label} NON chargées :`, err.message);
  }
}

// Routes à chemin précis AVANT les routes montées sur /api
mount("/auth", "./routes/auth", "Auth");
mount("/auth", "./routes/passwordReset", "Mot de passe oublié");
// walletOps remplace /wallet/withdraw et /wallet/deposit/callback (versions atomiques) ; le reste de /wallet est inchangé.
mount("/", "./routes/walletOps", "Opérations portefeuille V2");
mount("/wallet", "./routes/wallet", "Wallet");
mount("/api/omnicheck", "./routes/omnicheck", "OMNICHECK");
mount("/api/manual", "./routes/manualPayments", "Paiements manuels");
mount("/api/email-otp", "./routes/emailOtp", "OTP e-mail");
mount("/api/admin", "./routes/adminDash", "Tableau de bord admin");
mount("/api", "./routes/accountIds", "Identifiants et reçus");
mount("/api/coingate", "./routes/coingate", "CoinGate");
mount("/api/binance-pay", "./routes/binancePay", "Binance Pay");
mount("/api/web3", "./routes/web3", "Web3");
mount("/api", "./routes/binance", "Binance");

// =========================
// Erreurs
// =========================

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route introuvable" });
});

app.use((err, req, res, next) => {
  console.error("ERREUR_SERVEUR", err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: "Erreur serveur" });
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED_REJECTION", reason && reason.message ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION", err && err.stack ? err.stack : err);
});

// =========================
// Démarrage
// =========================

const PORT = process.env.PORT || 3000;

console.log("PAYDUNYA_MASTER_KEY:", !!process.env.PAYDUNYA_MASTER_KEY);
console.log("PAYDUNYA_PRIVATE_KEY:", !!process.env.PAYDUNYA_PRIVATE_KEY);
console.log("PAYDUNYA_TOKEN:", !!process.env.PAYDUNYA_TOKEN);
console.log("PAYDUNYA_PUBLIC_KEY:", !!process.env.PAYDUNYA_PUBLIC_KEY);
console.log("PAYDUNYA_MODE:", process.env.PAYDUNYA_MODE);
console.log("ADMIN_KEY:", !!process.env.ADMIN_KEY);
console.log("DATABASE_URL:", !!process.env.DATABASE_URL);

app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("OMNIPAY BACKEND V2.0 DEMARRE");
  console.log(`PORT : ${PORT}`);
  console.log("================================");
  try { require("./routes/omnicheck").startScheduler(); } catch (err) { console.error("[OMNICHECK] non démarré :", err.message); }
});
