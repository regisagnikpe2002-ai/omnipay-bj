"use strict";

const API_BASE = window.location.origin;
const state = {
  accessToken: localStorage.getItem("omnipayAccessToken") || "",
  user: null,
  wallet: null,
};

const byId = (id) => document.getElementById(id);
const setText = (id, value) => { const el = byId(id); if (el) el.textContent = value; };
const show = (id) => byId(id)?.classList.remove("hidden");
const hide = (id) => byId(id)?.classList.add("hidden");

function setBadge(id, text, kind = "warn") {
  const el = byId(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "warn", "error");
  el.classList.add(kind);
}

function formatMoney(value, currency = "XOF") {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, currencyDisplay: "code", maximumFractionDigits: 2 }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function clearSession() {
  localStorage.removeItem("omnipayAccessToken");
  localStorage.removeItem("refreshToken");
  state.accessToken = "";
  state.user = null;
  state.wallet = null;
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;
  const response = await fetch(API_BASE + path, { ...options, headers });
  const data = await response.json().catch(() => ({ message: "Réponse serveur invalide." }));
  if (response.status === 401) { clearSession(); throw new Error("Session expirée. Reconnectez-vous."); }
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

async function checkApi() {
  try { const data = await apiRequest("/api/status"); setBadge("apiBadge", `API · ${data.status || "ONLINE"}`, "ok"); }
  catch { setBadge("apiBadge", "API · indisponible", "error"); }
}

function showLogin() { show("loginPanel"); hide("dashboardPanel"); }
function showDashboard() {
  hide("loginPanel"); show("dashboardPanel");
  const name = [state.user?.firstName, state.user?.lastName].filter(Boolean).join(" ") || state.user?.email || state.user?.phone || "utilisateur OMNIPAY";
  setText("welcomeName", name);
}

async function login(event) {
  event.preventDefault();
  const button = byId("loginButton");
  button.disabled = true;
  setText("loginMessage", "Connexion en cours...");
  try {
    const data = await apiRequest("/auth/login", { method: "POST", body: JSON.stringify({ identifier: byId("loginIdentifier").value.trim(), password: byId("loginPassword").value }) });
    if (!data.accessToken) throw new Error("Token de connexion absent.");
    state.accessToken = data.accessToken; state.user = data.user || null;
    localStorage.setItem("omnipayAccessToken", data.accessToken);
    if (data.refreshToken) localStorage.setItem("refreshToken", data.refreshToken);
    setText("loginMessage", ""); showDashboard(); await loadDashboard();
  } catch (error) { setText("loginMessage", error.message); }
  finally { button.disabled = false; }
}

async function loadGateway() {
  try {
    const data = await apiRequest("/api/gateway/status");
    state.user = data.user || state.user;
    const verified = data.user?.kycStatus === "verified";
    setBadge("kycBadge", verified ? "Vérifié" : (data.user?.kycStatus || "Non vérifié"), verified ? "ok" : "warn");
    setBadge("paydunyaBadge", "PayDunya · prêt", "ok");
    setBadge("paydunyaStatus", "Disponible", "ok");
  } catch (error) {
    if (String(error.message).toLowerCase().includes("kyc")) setBadge("kycBadge", "KYC requis", "warn");
    else setBadge("kycBadge", "Accès refusé", "error");
    setBadge("paydunyaStatus", "Protégé", "warn");
  }
}

async function loadBinance() {
  try {
    const data = await apiRequest("/api/gateway/status");
    const enabled = data.gateway === "enabled";
    setBadge("binanceBadge", enabled ? "Binance · Gateway" : "Binance · attente", enabled ? "ok" : "warn");
    setBadge("binanceStatus", enabled ? "Gateway prêt" : "Configuration requise", enabled ? "ok" : "warn");
  } catch { setBadge("binanceBadge", "Binance · protégé", "warn"); setBadge("binanceStatus", "KYC requis", "warn"); }
}

async function loadWallet() {
  const data = await apiRequest("/wallet/me");
  const wallet = data.wallet || data;
  if (!wallet || wallet.balance === undefined) throw new Error("Wallet introuvable.");
  state.wallet = wallet;
  setText("walletBalance", formatMoney(wallet.balance, wallet.currency || "XOF"));
  setText("balanceNote", "Solde réel du portefeuille OMNIPAY.");
}

async function loadTransactions() {
  const data = await apiRequest("/wallet/transactions");
  const items = Array.isArray(data.transactions) ? data.transactions : Array.isArray(data) ? data : [];
  const box = byId("transactionList");
  if (!items.length) { box.innerHTML = '<div class="transaction"><span>Aucune transaction</span><span>-</span></div>'; return; }
  box.innerHTML = items.slice(0, 8).map((tx) => `<div class="transaction"><span>${escapeHtml(tx.type || "Transaction")}</span><strong>${escapeHtml(formatMoney(tx.amount, tx.currency || "XOF"))}</strong></div>`).join("");
}

async function loadDashboard() {
  const results = await Promise.allSettled([loadGateway(), loadBinance(), loadWallet(), loadTransactions()]);
  if (results[2].status === "rejected") { setText("walletBalance", "Indisponible"); setText("balanceNote", results[2].reason.message); }
  showDashboard();
}

async function deposit() {
  const value = prompt("Montant du dépôt en FCFA :");
  if (!value) return;
  try {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Montant invalide.");
    const data = await apiRequest("/wallet/deposit", { method: "POST", body: JSON.stringify({ amount }) });
    if (!data.paymentUrl) throw new Error("URL PayDunya absente.");
    window.location.href = data.paymentUrl;
  } catch (error) { alert(error.message); }
}

function logout() { clearSession(); window.location.reload(); }

document.addEventListener("DOMContentLoaded", async () => {
  await checkApi();
  byId("loginForm")?.addEventListener("submit", login);
  byId("logoutBtn")?.addEventListener("click", logout);
  byId("depositBtn")?.addEventListener("click", deposit);
  byId("withdrawBtn")?.addEventListener("click", () => alert("Retrait bientôt disponible."));
  byId("transferBtn")?.addEventListener("click", () => alert("Transfert OMNIPAY bientôt disponible."));
  byId("forgotPasswordBtn")?.addEventListener("click", () => { window.location.href = "/forgot-password.html"; });
  if (state.accessToken) { showDashboard(); await loadDashboard(); } else showLogin();
});
