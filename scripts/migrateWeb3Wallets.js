require("dotenv").config({ path: ".env.local" });

const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS web3_challenges (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,
      wallet_address VARCHAR(42) NOT NULL,
      chain_id INTEGER NOT NULL,
      nonce_hash TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log("WEB3_CHALLENGES_TABLE_OK");
}

migrate().catch((error) => {
  console.error("MIGRATION_ERROR", {
    message: error.message,
    code: error.code,
  });

  process.exitCode = 1;
});
