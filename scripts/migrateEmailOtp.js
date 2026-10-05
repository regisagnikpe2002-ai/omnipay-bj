require("dotenv").config({ path: ".env.local" });

const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquante.");
}

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS email_otp_challenges (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS email_otp_email_purpose_idx
    ON email_otp_challenges (email, purpose, created_at DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS email_otp_expiration_idx
    ON email_otp_challenges (expires_at)
  `;

  console.log("EMAIL_OTP_MIGRATION_OK");
}

migrate()
  .catch((error) => {
    console.error("EMAIL_OTP_MIGRATION_ERROR", error);
    process.exitCode = 1;
  });
