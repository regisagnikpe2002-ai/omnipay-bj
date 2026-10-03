require("dotenv").config({ path: ".env.local" });

const { desc } = require("drizzle-orm");
const { db } = require("./db/index.js");
const { transactions } = require("./db/schema.js");

(async () => {
  try {
    const rows = await db.query.transactions.findMany({
      orderBy: [desc(transactions.createdAt)],
      limit: 30,
    });

    console.table(
      rows.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        status: tx.status,
        provider: tx.provider,
        providerRef: tx.providerRef,
        createdAt: tx.createdAt,
      }))
    );
  } catch (error) {
    console.error("INSPECTION_ERROR", error);
  } finally {
    process.exit();
  }
})();
