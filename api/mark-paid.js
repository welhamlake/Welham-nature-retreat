
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function page(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body style="font:16px Arial,sans-serif;max-width:500px;margin:40px auto;padding:20px">
<h1>Welham Nature Retreat</h1>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
</body></html>`;
}

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(
      page('Method not allowed', 'Use the secure payment form.')
    );
  }

  const { reference, owner_password } = req.body || {};

  if (!passwordMatches(
    owner_password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(
      page('Access denied', 'Incorrect owner password.')
    );
  }

  if (typeof reference !== 'string' ||
      !/^WEL-[A-Z0-9]+$/.test(reference)) {
    return res.status(400).send(
      page('Invalid reference', 'Check the booking reference.')
    );
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(
      page('Unavailable', 'Database connection unavailable.')
    );
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
    const result = await pool.query(
      `UPDATE public.bookings
       SET payment_status = 'paid',
           paid_at = NOW(),
           status = 'confirmed'
       WHERE request_reference = $1
         AND status = 'approved'
         AND payment_status = 'unpaid'
       RETURNING request_reference`,
      [reference]
    );

    if (!result.rows.length) {
      return res.status(409).send(
        page(
          'Cannot mark as paid',
          'This booking is not awaiting payment, or has already been processed.'
        )
      );
    }

    return res.status(200).send(
      page(
        'Payment recorded',
        `Payment recorded for ${reference}. Customer confirmation email has not been sent yet.`
      )
    );
  } catch (error) {
    console.error('Mark paid error:', error.code);
    return res.status(500).send(
      page('Error', 'Unable to record this payment.')
    );
  } finally {
    await pool.end();
  }
}
