"use strict";

function money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function buildAdvice(snapshot) {
  const balance = money(snapshot.balance);
  const deposits30 = money(snapshot.deposits30);
  const withdrawals30 = money(snapshot.withdrawals30);
  const commissions30 = money(snapshot.commissions30);
  const transactionCount = Number(snapshot.transactionCount || 0);
  const advice = [];

  if (transactionCount === 0) {
    advice.push({
      type: "welcome",
      priority: 1,
      title: "Bienvenue dans OMNIPAY",
      message: "Enregistrez votre numéro préféré pour simplifier vos prochaines opérations.",
      action: "operators"
    });
  }

  if (balance < 1000) {
    advice.push({
      type: "balance",
      priority: 1,
      title: "Solde faible",
      message: "Votre solde disponible est inférieur à 1 000 FCFA. Vous pouvez recevoir un dépôt avant votre prochaine opération.",
      action: "deposit"
    });
  }

  if (deposits30 > 0 && withdrawals30 > deposits30 * 0.8) {
    advice.push({
      type: "budget",
      priority: 2,
      title: "Surveillez vos sorties",
      message: "Vos retraits récents sont proches de vos dépôts. Définissez un objectif volontaire pour mieux organiser votre solde.",
      action: "goal"
    });
  }

  if (commissions30 > 0) {
    advice.push({
      type: "fees",
      priority: 3,
      title: "Frais des 30 derniers jours",
      message: `Vos commissions récentes représentent ${commissions30} FCFA. Vérifiez toujours les frais avant confirmation.`,
      action: "history"
    });
  }

  if (balance >= 10000) {
    const suggestedAmount = Math.max(1000, Math.floor(balance * 0.1));
    advice.push({
      type: "goal",
      priority: 4,
      title: "Créez un objectif personnel",
      message: `Vous pouvez réserver volontairement ${suggestedAmount} FCFA dans votre organisation personnelle.`,
      action: "goal",
      suggestedAmount
    });
  }

  advice.push({
    type: "security",
    priority: 5,
    title: "Gardez le contrôle",
    message: "OLATOUNDE ne demandera jamais votre code PIN Mobile Money, votre OTP ou votre phrase secrète.",
    action: "security"
  });

  return advice.sort((a, b) => a.priority - b.priority).slice(0, 4);
}

module.exports = { buildAdvice, money };
