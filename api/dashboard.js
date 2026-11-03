
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function layout(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Welham Booking Dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:22px 16px}
main{max-width:900px;margin:auto;padding:18px}
h1{font-size:23px;margin:0}
h2{font-size:20px}
.card{background:white;border-radius:12px;padding:17px;margin:14px 0;box-shadow:0 2px 8px #0001}
input,button{font:inherit;padding:13px;border-radius:8px;width:100%;margin:8px 0}
input{border:1px solid #bbb}
button,.action{display:block;background:#234735;color:white;border:0;border-radius:8px;padding:13px;text-align:center;text-decoration:none;font-weight:bold;margin:8px 0}
.action.secondary{background:#546b60}
small{color:#66736a}
.status{font-weight:bold}
</style>
</head>
<body>
<header><h1>Welham Nature Retreat</h1><div>Booking Management</div></header>
<main>${content}</main>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(layout(`
      <div class="card">
        <h2>Owner Login</h2>
        <form method="POST" action="/api/dashboard">
          <label for="password">Owner password</label>
          <input id="password" name="password" type="password"
                 autocomplete="current-password" required>
          <button type="submit">View Bookings</button>
        </form>
      </div>`));
  }

  if (req.method !== 'POST') {
    return res.status(405).send(layout('Method not allowed'));
  }

  const password = typeof req.body === 'string'
    ? new URLSearchParams(req.body).get('password')
    : req.body?.password;

  if (!passwordMatches(password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(layout(
      '<div class="card"><h2>Access denied</h2><p>Incorrect password.</p><a href="/api/dashboard">Try again</a></div>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(layout('Database unavailable'));
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
      SELECT request_reference, guest_name, type,
             start_date, end_date, session,
             status, payment_status, total_pence
      FROM public.bookings
      ORDER BY start_date DESC
      LIMIT 100
    `);

    const cards = result.rows.map(b => {
      const ref = escapeHtml(b.request_reference);
      const actions = [];

      if (b.status === 'pending') {
        actions.push(
          '<p><small>Approval and decline controls will be connected to the existing secure booking review system.</small></p>'
        );
      }

      if (b.status === 'approved' && b.payment_status === 'unpaid') {
        actions.push(
          '<a class="action" href="/api/payment-admin">Mark as Paid</a>'
        );
      }

      return `
        <div class="card">
          <h2>${escapeHtml(b.guest_name)}</h2>
          <p><strong>Reference:</strong> ${ref}</p>
          <p><strong>Experience:</strong> ${escapeHtml(b.type)}</p>
          <p><strong>Start:</strong> ${formatDate(b.start_date)}</p>
          ${b.end_date ? `<p><strong>End:</strong> ${formatDate(b.end_date)}</p>` : ''}
          ${b.session ? `<p><strong>Session:</strong> ${escapeHtml(b.session)}</p>` : ''}
          <p class="status">Booking: ${escapeHtml(b.status)}</p>
          <p class="status">Payment: ${escapeHtml(b.payment_status)}</p>
          <p><strong>Total:</strong> £${(Number(b.total_pence) / 100).toFixed(2)}</p>
          ${actions.join('')}
        </div>`;
    }).join('');

    return res.status(200).send(layout(`
      <h2>Your Bookings (${result.rows.length})</h2>
      <small>Showing up to 100 bookings, newest dates first.</small>
      ${cards || '<div class="card">No bookings found.</div>'}
      <p><a href="/api/dashboard">Return to login</a></p>
    `));
  } catch (error) {
    console.error('Dashboard error:', error.code || error.message);
    return res.status(500).send(layout(
      '<div class="card">Unable to load bookings.</div>'
    ));
  } finally {
    await pool.end();
  }
}
