require("dotenv").config({ path: ".env.local" });

const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante.");
}

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified
    BOOLEAN NOT NULL DEFAULT FALSE
  `;

  console.log("EMAIL_VERIFIED_MIGRATION_OK");
}

migrate()
  .catch((error) => {
    console.error(
      "EMAIL_VERIFIED_MIGRATION_ERROR",
      error
    );
    process.exitCode = 1;
  });
