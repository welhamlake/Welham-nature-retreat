
const { Pool } = require('pg');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      status: 'not_configured'
    });
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    max: 1
  });

  try {
    await pool.query('SELECT 1');
    return res.status(200).json({
      status: 'connected'
    });
  } catch (error) {
    console.error('Database connection test failed:', error.code);
    return res.status(503).json({
      status: 'connection_failed'
    });
  } finally {
    await pool.end();
  }
};
