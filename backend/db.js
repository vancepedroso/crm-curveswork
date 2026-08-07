const { Pool } = require("pg");
require("dotenv").config();

// ← Managed Postgres providers require TLS on connections that leave their
//   network, and node-postgres won't negotiate it on its own the way psql
//   does — without this the connection is reset with ECONNRESET. Detected
//   from the connection string so local development (plain localhost) is
//   unaffected, and Render's *internal* URL, which stays inside their
//   private network, doesn't pay for TLS it doesn't need.
const connectionString = process.env.DATABASE_URL || "";
const needsSsl = /\.render\.com|\.amazonaws\.com|sslmode=require/.test(connectionString);

const pool = new Pool({
  connectionString,
  // rejectUnauthorized:false because these providers present certificates
  // signed by their own internal CA, which isn't in Node's trust store.
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on("error", (err) => {
  console.error("Unexpected DB pool error", err);
  process.exit(-1);
});

module.exports = pool;