"use strict";
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { readFileSync } = require("node:fs");

function loadEnvFile() {
  const p = process.env.ENV_FILE || "/run/secrets/panel.env";
  try {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* Docker env may already be populated. */
  }
}
loadEnvFile();

(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    ssl: false,
  });
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS setup_tokens (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL, used_at timestamptz)",
  );
  await pool.query(
    "DELETE FROM setup_tokens WHERE used_at IS NOT NULL OR expires_at < now()",
  );
  await pool.query(
    "INSERT INTO setup_tokens(token_hash, expires_at) VALUES ($1, now() + interval '24 hours')",
    [hash],
  );
  await pool.end();
  process.stdout.write(
    `One-time setup token (valid for 24 hours):\n${token}\n`,
  );
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
