
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const token = req.query.token;

  if (typeof token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).send('Invalid approval link.');
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
      `SELECT request_reference, guest_name, type,
              start_date, end_date, session,
              guests, total_pence, status
       FROM public.bookings
       WHERE approval_token_hash = $1
       LIMIT 1`,
      [hash]
    );

    if (!result.rows.length) {
      return res.status(404).send('Booking not found.');
    }

    const b = result.rows[0];

    const date = value => value
      ? new Date(value).toLocaleDateString('en-GB', {
          timeZone: 'UTC',
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        })
      : 'Not applicable';

    const page = `
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport"
              content="width=device-width,initial-scale=1">
        <title>Welham Booking Approval</title>
        <style>
          body {
            background: #f7f4ed;
            color: #172c24;
            font: 16px Arial, sans-serif;
            padding: 24px;
          }
          main {
            max-width: 480px;
            margin: 30px auto;
            background: white;
            padding: 28px;
            border-radius: 12px;
          }
          h1 { font-size: 26px; }
          p { line-height: 1.7; }
        </style>
      </head>
      <body>
        <main>
          <h1>Welham Nature Retreat</h1>
          <h2>Booking Review</h2>
          <p><strong>Reference:</strong>
            ${escapeHtml(b.request_reference)}</p>
          <p><strong>Guest:</strong>
            ${escapeHtml(b.guest_name)}</p>
          <p><strong>Experience:</strong>
            ${escapeHtml(b.type)}</p>
          <p><strong>Arrival:</strong>
            ${escapeHtml(date(b.start_date))}</p>
          <p><strong>Departure:</strong>
            ${escapeHtml(date(b.end_date))}</p>
          <p><strong>Session:</strong>
            ${escapeHtml(b.session || 'Not applicable')}</p>
          <p><strong>Guests:</strong>
            ${escapeHtml(b.guests)}</p>
          <p><strong>Total:</strong>
            £${(b.total_pence / 100).toFixed(2)}</p>
          <p><strong>Status:</strong>
            ${escapeHtml(b.status)}</p>
          <hr>
          <p>Booking approval controls will be
          activated in the next setup step.</p>
          <p>No payment has been requested.</p>
        </main>
      </body>
      </html>
    `;

    return res.status(200).send(page);
  } catch (error) {
    console.error('Approval page error', error.code);
    return res.status(500).send('Unable to load booking.');
  } finally {
    await pool.end();
  }
}
