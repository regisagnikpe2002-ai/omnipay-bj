"use strict";

const API_BASE = window.location.origin;
const state = {
  accessToken: localStorage.getItem("omnipayAccessToken") || "",
  user: null,
  wallet: null,
  transactions: [],
};

const byId = (id) => document.getElementById(id);
const setText = (id, value) => { const el = byId(id); if (el) el.textContent = value; };
const show = (id) => byId(id)?.classList.remove("hidden");
const hide = (id) => byId(id)?.classList.add("hidden");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value, currency = "XOF") {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

function clearSession() {
  localStorage.removeItem("omnipayAccessToken");
  localStorage.removeItem("refreshToken");
  state.accessToken = "";
  state.user = null;
  state.wallet = null;
  state.transactions = [];
}

async function apiRequest(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.accessToken) headers.Authorization = `Bearer ${state.accessToken}`;

  const response = await fetch(API_BASE + path, { ...options, headers });
  const data = await response.json().catch(() => ({ error: "Réponse serveur invalide." }));

  if (response.status === 401) {
    clearSession();
    throw new Error("Session expirée. Reconnectez-vous.");
  }
  if (!response.ok) throw new Error(data.error || data.message || "Une erreur est survenue.");
  return data;
}

async function checkBackend() {
  try {
    const data = await apiRequest("/api/status");
    setText("backendStatus", `${data.application} • ${data.status}`);
  } catch (error) {
    setText("backendStatus", "Serveur indisponible");
    console.error("BACKEND_STATUS_ERROR", error);
  }
}

function showLogin() { show("loginPanel"); hide("dashboardPanel"); }
function showDashboard() {
  hide("loginPanel");
  show("dashboardPanel");

  const displayName =
    [state.user?.firstName, state.user?.lastName]
      .filter(Boolean)
      .join(" ") ||
    state.user?.email ||
    state.user?.phone ||
    "utilisateur OMNIPAY";

  setText("welcomeName", displayName);
}

async function login(event) {
  event.preventDefault();
  const button = byId("loginButton");
  button.disabled = true;
  setText("loginMessage", "Connexion en cours...");

  try {
    const data = await apiRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        identifier: byId("loginIdentifier").value.trim(),
        password: byId("loginPassword").value,
      }),
    });
    if (!data.accessToken) throw new Error("Token de connexion absent.");
    state.accessToken = data.accessToken;
    state.user = data.user || null;
    localStorage.setItem("omnipayAccessToken", data.accessToken);
    if (data.refreshToken) localStorage.setItem("refreshToken", data.refreshToken);
    setText("loginMessage", "");
    showDashboard();
    await loadDashboard();
  } catch (error) {
    setText("loginMessage", error.message);
  } finally {
    button.disabled = false;
  }
}

async function loadWallet() {
  const data = await apiRequest("/wallet/me");
  if (!data.wallet) throw new Error("Wallet introuvable.");
  state.wallet = data.wallet;
  setText("balanceValue", formatMoney(data.wallet.balance, data.wallet.currency || "XOF"));
  setText("balanceNote", data.wallet.status === "active" ? "Solde réel enregistré dans votre compte OMNIPAY." : `État du portefeuille : ${data.wallet.status}`);
}

function renderTransactions(items) {
  const container = byId("transactionList");
  if (!items.length) {
    container.innerHTML = '<div class="transaction"><div><div class="t-name">Aucune transaction</div><div class="muted small">Aucune activité enregistrée.</div></div><div>-</div></div>';
    return;
  }
const completed = 
tx.status === 
"completed";
const positive =
  completed &&
  ["deposit", 
"transfer_in"].includes(tx.type);

const sign =
  tx.status === "pending"
    ? ""
    : positive
    ? "+"
    : "-";

const css =
  tx.status === "pending"
    ? "pending"
    : positive
    ? "positive"
    : "negative";
 
}

async function loadTransactions() {
  const data = await apiRequest("/wallet/transactions");
  state.transactions = Array.isArray(data.transactions) ? data.transactions : [];
  renderTransactions(state.transactions);
}

async function loadDashboard() {
  setText("balanceValue", "Chargement...");
  setText("balanceNote", "Lecture sécurisée du solde réel.");
  try {
    await Promise.all([loadWallet(), loadTransactions()]);
  } catch (error) {
    setText("balanceValue", "Indisponible");
    setText("balanceNote", error.message);
    if (!state.accessToken) showLogin();
  }
}

async function connectMetaMask() {
  const status = byId("web3WalletStatus");
  const button = byId("connectMetaMaskBtn");
  if (!state.accessToken) { status.textContent = "Connectez-vous d’abord à OMNIPAY."; return; }
  if (!window.ethereum) { status.textContent = "MetaMask non détecté."; show("walletNotice"); setText("walletNotice", "Installez MetaMask dans ce navigateur pour continuer."); return; }

  button.disabled = true;
  status.textContent = "Connexion au portefeuille...";
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainHex = await window.ethereum.request({ method: "eth_chainId" });
    const address = accounts[0];
    const chainId = Number.parseInt(chainHex, 16);
    if (chainId !== 8453) { status.textContent = "Sélectionnez le réseau Base."; return; }
    const challenge = await apiRequest("/api/web3/challenge", {
      method: "POST",
      body: JSON.stringify({ walletAddress: address, chainId }),
    });
    status.textContent = `Wallet détecté : ${formatAddress(address)}`;
    show("walletNotice");
    setText("walletNotice", `Challenge créé pour ${formatAddress(address)}. La signature de vérification sera la prochaine étape.`);
    console.log("WEB3_CHALLENGE_CREATED", { challengeId: challenge.challengeId, expiresIn: challenge.expiresIn });
  } catch (error) {
    status.textContent = error.message || "Connexion impossible.";
  } finally {
    button.disabled = false;
  }
}

async function depositInfo() {
  try {
    const amount = prompt("Montant à déposer (FCFA) :");
    if (!amount) return;

    const data = await apiRequest("/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({
        amount: Number(amount)
      })
    });

    if (!data.paymentUrl) {
      throw new Error("URL de paiement introuvable.");
    }

    window.location.href = data.paymentUrl;
  } catch (error) {
    alert(error.message || "Erreur lors de l'initiation du dépôt.");
  }
}
function withdrawInfo() { alert("Les retraits sont actuellement traités manuellement par l’administration OMNIPAY."); }
function logout() { clearSession(); window.location.reload(); }

document.addEventListener("DOMContentLoaded", async () => {
  await checkBackend();
  byId("loginForm")?.addEventListener("submit", login);
  byId("connectMetaMaskBtn")?.addEventListener("click", connectMetaMask);
  byId("depositBtn")?.addEventListener("click", depositInfo);
  byId("withdrawBtn")?.addEventListener("click", withdrawInfo);
  byId("logoutBtn")?.addEventListener("click", logout);
  if (state.accessToken) { showDashboard(); await loadDashboard(); } else { showLogin(); }
});
