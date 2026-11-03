
import pg from 'pg';
import { createHash } from 'node:crypto';

const { Pool } = pg;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function page(title, message, content = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} | Welham</title>
<style>
body{font:16px Arial,sans-serif;background:#f7f4ed;color:#172c24;padding:20px}
main{max-width:480px;margin:30px auto;background:white;padding:25px;border-radius:12px}
button{background:#284739;color:white;padding:14px 20px;border:0;border-radius:5px;font-size:16px}
a{color:#284739}
</style>
</head>
<body><main>
<h1>Welham Nature Retreat</h1>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
${content}
</main></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const { token, decision, confirm } = req.body || {};

  if (typeof token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !['approve', 'decline'].includes(decision)) {
    return res.status(400).send(
      page('Invalid request', 'Please use your booking review link.')
    );
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send('Database unavailable.');
  }

  const hash = createHash('sha256')
    .update(token).digest('hex');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.SUPABASE_CA_CERT
        ? { ca: process.env.SUPABASE_CA_CERT }
        : {})
    },
    connectionTimeoutMillis: 5000,
    max: 1
  });

  try {
    const result = await pool.query(
      `SELECT request_reference, guest_name, status
       FROM public.bookings
       WHERE approval_token_hash = $1
       LIMIT 1`,
      [hash]
    );

    if (!result.rows.length) {
      return res.status(404).send(
        page('Not found', 'This booking link is invalid.')
      );
    }

    const booking = result.rows[0];

    if (booking.status !== 'pending') {
      return res.status(409).send(
        page('Already processed',
          'This booking is no longer pending.')
      );
    }

if (confirm === 'yes' &&
    req.body.owner_password !== process.env.BOOKING_ADMIN_PASSWORD) {
  return res.status(403).send(
    page('Access denied', 'Incorrect owner password.')
  );
}

    if (confirm !== 'yes') {
      const action = decision === 'approve'
        ? 'Approve'
        : 'Decline';

      return res.status(200).send(page(
        `Confirm ${action}`,
        `Are you sure you want to ${decision} booking ${booking.request_reference} for ${booking.guest_name}?`,
        `<form method="POST" action="/api/booking-decision">
          <input type="hidden" name="token" value="${escapeHtml(token)}">
          <input type="hidden" name="decision" value="${escapeHtml(decision)}">
          <input type="hidden" name="confirm" value="yes">
          
<label for="owner_password">Owner password</label>
<input
  id="owner_password"
  type="password"
  name="owner_password"
  required
  autocomplete="off"
  style="display:block;width:90%;padding:12px;margin:12px 0;"
>
<button type="submit">Yes, ${action}</button>
        </form>
        <p><a href="/api/approve?token=${encodeURIComponent(token)}">Go back</a></p>`
      ));
    }

    const newStatus = decision === 'approve'
      ? 'approved'
      : 'declined';

    const updated = await pool.query(
      `UPDATE public.bookings
       SET status = $1,
           approved_at = CASE
             WHEN $1 = 'approved' THEN NOW()
             ELSE approved_at
           END,
           payment_due_at = CASE
             WHEN $1 = 'approved'
             THEN NOW() + INTERVAL '24 hours'
             ELSE payment_due_at
           END
       WHERE approval_token_hash = $2
         AND status = 'pending'
       RETURNING request_reference`,
      [newStatus, hash]
    );

    if (!updated.rows.length) {
      return res.status(409).send(
        page('Already processed',
          'This booking has already been handled.')
      );
    }

    return res.status(200).send(page(
      decision === 'approve' ? 'Booking approved' : 'Booking declined',
      decision === 'approve'
        ? 'The booking is approved in the database. Payment instructions have NOT been emailed yet.'
        : 'The booking has been declined in the database. The customer has NOT been emailed yet.'
    ));

  } catch (error) {
    console.error('Booking decision error', error.code);
    return res.status(500).send(
      page('Error', 'Unable to process this booking.')
    );
  } finally {
    await pool.end();
  }
}
