
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';

  if (
    !secret ||
    !safeEqual(auth, `Bearer ${secret}`)
  ) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      error: 'Database unavailable'
    });
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.SUPABASE_CA_CERT
        ? { ca: process.env.SUPABASE_CA_CERT }
        : {})
    },
    max: 1,
    connectionTimeoutMillis: 5000
  });

  try {
    const result = await pool.query(`
      WITH expired_pending AS (
        UPDATE public.bookings
        SET status = 'expired'
        WHERE status = 'pending'
          AND payment_status = 'unpaid'
          AND expires_at <= NOW()
        RETURNING id
      ),
      expired_approved AS (
        UPDATE public.bookings
        SET status = 'expired'
        WHERE status = 'approved'
          AND payment_status = 'unpaid'
          AND payment_due_at <= NOW()
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*) FROM expired_pending)
          AS pending_expired,
        (SELECT COUNT(*) FROM expired_approved)
          AS approved_expired
    `);

    return res.status(200).json({
      success: true,
      pending_expired:
        Number(result.rows[0].pending_expired),
      approved_expired:
        Number(result.rows[0].approved_expired)
    });

  } catch (error) {
    console.error(
      'Booking expiry error:',
      error.code || error.message
    );

    return res.status(500).json({
      error: 'Unable to expire bookings'
    });

  } finally {
    await pool.end();
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length &&
    timingSafeEqual(x, y);
}
