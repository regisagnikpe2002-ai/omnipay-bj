require("dotenv").config({ path: ".env.local" });

const { eq, and, desc } = require("drizzle-orm");
const { db } = require("./db/index.js");
const { transactions } = require("./db/schema.js");
const { confirmInvoice } = require("./providers/paydunya.js");

function mask(value) {
  if (!value) return null;
  const text = String(value);
  return text.length <= 8
    ? "****"
    : `${text.slice(0, 4)}...${text.slice(-4)}`;
}

(async () => {
  try {
    const pendingDeposits = await db.query.transactions.findMany({
      where: and(
        eq(transactions.type, "deposit"),
        eq(transactions.status, "pending")
      ),
      orderBy: [desc(transactions.createdAt)],
      limit: 30,
    });

    console.log(
      `DEPOTS_PENDING_TROUVES: ${pendingDeposits.length}`
    );

    const results = [];

    for (const tx of pendingDeposits) {
      if (!tx.providerRef) {
        results.push({
          id: tx.id,
          amount: tx.amount,
          token: null,
          paydunyaStatus: "TOKEN_ABSENT",
          responseCode: null,
        });
        continue;
      }

      try {
        const confirmation = await confirmInvoice(tx.providerRef);

        results.push({
          id: tx.id,
          amount: tx.amount,
          token: mask(tx.providerRef),
          paydunyaStatus:
            confirmation?.status || "STATUT_ABSENT",
          responseCode:
            confirmation?.response_code || null,
          confirmedAmount:
            confirmation?.invoice?.total_amount ??
            confirmation?.total_amount ??
            null,
        });
      } catch (error) {
        results.push({
          id: tx.id,
          amount: tx.amount,
          token: mask(tx.providerRef),
          paydunyaStatus: "ERREUR_CONFIRMATION",
          responseCode:
            error.response?.data?.response_code || null,
          detail:
            error.response?.data?.response_text ||
            error.message,
        });
      }
    }

    console.table(results);
  } catch (error) {
    console.error(
      "VERIFICATION_GLOBALE_ECHOUEE",
      error.response?.data || error.message
    );
  } finally {
    process.exit();
  }
})();
