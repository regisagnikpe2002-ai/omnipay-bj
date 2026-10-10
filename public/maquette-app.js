const API_BASE = 
window.location.origin;

const appState = {
  accessToken:
    
localStorage.getItem("omnipayAccessToken") 
||
    
localStorage.getItem("accessToken") 
||
    "",
  user: null,
  wallet: null,
  transactions: [],
};

function byId(id) {
  return 
document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);

  if (element) {
    element.textContent = value;
  }
}

function show(id) {
  
byId(id)?.classList.remove("hidden");
}

function hide(id) {
  byId(id)?.classList.add("hidden");
}

function formatMoney(value, currency 
= "XOF") {
  const amount = Number(value || 0);

  return new 
Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  return new 
Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatAddress(address) {
  if (!address) {
    return "";
  }

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-4)
  );
}

function getTransactionLabel(type) {
  const labels = {
    deposit: "Dépôt",
    withdrawal: "Retrait",
    transfer_in: "Transfert reçu",
    transfer_out: "Transfert envoyé",
    commission: "Commission",
  };

  return labels[type] || type || "Transaction";
}

function isPositiveTransaction(type) 
{
  return [
    "deposit",
    "transfer_in",
  ].includes(type);
}

function decodeJwtPayload(token) {
  try {
    const payload = 
token.split(".")[1];

    const normalized = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    return JSON.parse(
      decodeURIComponent(
        atob(normalized)
          .split("")
          .map((character) => {
            return (
              "%" +
              character
                .charCodeAt(0)
                .toString(16)
                .padStart(2, "0")
            );
          })
          .join("")
      )
    );
  } catch {
    return {};
  }
}

function clearSession() {
  localStorage.removeItem(
    "omnipayAccessToken"
  );

  localStorage.removeItem(
    "accessToken"
  );

  localStorage.removeItem(
    "refreshToken"
  );

  appState.accessToken = "";
  appState.user = null;
  appState.wallet = null;
  appState.transactions = [];
}

async function apiRequest(
  path,
  options = {}
) {
  const headers = {
    ...(options.body
      ? {
          "Content-Type":
            "application/json",
        }
      : {}),
    ...(options.headers || {}),
  };

  if (appState.accessToken) {
    headers.Authorization =
      `Bearer 
${appState.accessToken}`;
  }

  const response = await fetch(
    API_BASE + path,
    {
      ...options,
      headers,
    }
  );

  const data = await response
    .json()
    .catch(() => ({
      success: false,
      error:
        "Réponse serveur invalide.",
    }));

  if (response.status === 401) {
    clearSession();

      throw new Error(
        "Session expirée. Reconnectez-vous."
      );
  }

    if (!response.ok) {
      throw new Error(
        data.error ||
        data.message ||
        "Une erreur est survenue."
      );
    }
