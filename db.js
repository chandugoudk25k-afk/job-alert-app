// db.js
require('dotenv').config();
const { Pool } = require('pg');

// strip any ?sslmode=... from the URL so code controls SSL
const connStr = (process.env.DATABASE_URL || '').replace(/\?sslmode=.*$/i, '');

const pool = new Pool({
  connectionString: connStr,
  // Heroku Postgres requires SSL; Windows often lacks CA chain
  ssl: { require: true, rejectUnauthorized: false }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
