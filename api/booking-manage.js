
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
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
<style>
body{font:16px Arial,sans-serif;background:#f3f5f1;color:#243328;padding:20px}
main{max-width:550px;margin:40px auto;background:white;padding:25px;border-radius:12px}
a{display:inline-block;background:#234735;color:white;padding:12px 18px;border-radius:8px;text-decoration:none}
</style>
</head>
<body><main>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
<a href="/api/calendar">Return to calendar</a>
</main></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(page(
      'Action unavailable',
      'This action must be submitted from your owner calendar.'
    ));
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(
    body.password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(page(
      'Incorrect password',
      'No changes were made.'
    ));
  }

  const action = String(body.action || '');
  const reference = String(body.request_reference || '');

  if (
    !['mark_paid', 'release_booking'].includes(action) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(reference)
  ) {
    return res.status(400).send(page(
      'Invalid booking action',
      'No changes were made.'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page(
      'Database unavailable',
      'Please try again later.'
    ));
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

  const client = await pool.connect().catch(() => null);

  if (!client) {
    await pool.end();
    return res.status(503).send(page(
      'Connection unavailable',
      'No changes were made.'
    ));
  }

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, request_reference, status,
              payment_status, payment_due_at
       FROM public.bookings
       WHERE request_reference = $1
       FOR UPDATE`,
      [reference]
    );

    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).send(page(
        'Booking not found or ambiguous',
        'No changes were made.'
      ));
    }

    const booking = result.rows[0];
    const status = String(booking.status || '').toLowerCase();
    const payment = String(booking.payment_status || '').toLowerCase();

    if (action === 'mark_paid') {
      if (status !== 'approved' || payment === 'paid') {
        await client.query('ROLLBACK');
        return res.status(409).send(page(
          'Booking cannot be marked paid',
          'Only approved, unpaid bookings can be confirmed.'
        ));
      }

      await client.query(
        `UPDATE public.bookings
         SET payment_status = 'paid',
             status = 'confirmed'
         WHERE id = $1`,
        [booking.id]
      );

      await client.query('COMMIT');

      return res.status(200).send(page(
        'Payment recorded',
        'Booking ' + reference +
        ' has been marked as paid and confirmed.'
      ));
    }

    if (
      status !== 'approved' ||
      payment === 'paid' ||
      !booking.payment_due_at ||
      new Date(booking.payment_due_at).getTime() > Date.now()
    ) {
      await client.query('ROLLBACK');
      return res.status(409).send(page(
        'Booking cannot be released',
        'Only approved, unpaid bookings past their payment deadline can be released.'
      ));
    }

    await client.query(
      `UPDATE public.bookings
       SET status = 'cancelled'
       WHERE id = $1`,
      [booking.id]
    );

    await client.query('COMMIT');

    return res.status(200).send(page(
      'Booking released',
      'Booking ' + reference +
      ' has been cancelled and its dates released.'
    ));

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error(
      'Booking management error:',
      error.code || error.message
    );

    return res.status(500).send(page(
      'Unable to update booking',
      'No successful change could be confirmed. Please check the booking before retrying.'
    ));

  } finally {
    client.release();
    await pool.end();
  }
}
