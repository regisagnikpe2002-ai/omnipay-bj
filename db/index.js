require("dotenv").config();
const { neon } = require("@neondatabase/serverless");
const { drizzle } = require("drizzle-orm/neon-http");
const schema = require("./schema");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL manquant dans le fichier .env");
}

const sql = neon(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });

module.exports = { db };