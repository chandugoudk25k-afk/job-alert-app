// migrate.js — one-time DB setup for Heroku Postgres on Windows
require('dotenv').config();
const { Client } = require('pg');

const SQL = `
CREATE TABLE IF NOT EXISTS job (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  title         TEXT NOT NULL,
  company       TEXT,
  location      TEXT,
  contract_type TEXT,
  url           TEXT,
  posted_at     TIMESTAMPTZ,
  description   TEXT,
  fetched_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS job_fetched_at_idx ON job (fetched_at DESC);
`;

// Strip any ?sslmode=... from the URL so our ssl object actually takes effect
const rawUrl = process.env.DATABASE_URL || "";
const connStr = rawUrl.replace(/\?sslmode=.*$/i, "");

(async () => {
  console.log("DATABASE_URL present?", Boolean(rawUrl));
  const client = new Client({
    connectionString: connStr,
    // Heroku requires SSL; Windows often can't validate the CA → skip verification
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log("Connecting…");
    await client.connect();
    console.log("Connected. Running migration…");
    await client.query(SQL);
    console.log("✅ Table created / already exists.");
  } catch (e) {
    console.error("❌ Migration failed:", e);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
