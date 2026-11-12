
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

function page(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Gift Voucher Management</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:15px Arial,sans-serif}
header{background:#234735;color:white;padding:20px}
header h1{margin:0;font-size:23px}
main{max-width:900px;margin:auto;padding:12px}
.panel{background:white;border-radius:12px;padding:16px;margin:12px 0}
input,button{font:inherit;padding:12px;border-radius:8px}
input{width:100%;border:1px solid #aaa;margin:8px 0}
button,.action{background:#234735;color:white;border:0;font-weight:bold;cursor:pointer}
.action{display:inline-block;text-decoration:none;padding:12px;margin:8px 0;border-radius:8px}
.login button{width:100%}
.voucher{border:1px solid #ddd;border-radius:10px;padding:15px;margin:12px 0;overflow-wrap:anywhere}
.voucher p{margin:7px 0}
.status{font-weight:bold}
.pending{color:#a16b00}
.paid{color:#16713b}
.redeemed{color:#555}
form.actionForm{border-top:1px solid #ddd;margin-top:14px;padding-top:12px}
form.actionForm label{display:block;font-weight:bold}
form.actionForm button{margin:5px 0}
.danger{background:#a83b3b}
.message{padding:12px;background:#e7f2e9;border-radius:8px}
.error{background:#fff0ed}
small{color:#627064}
</style>
</head>
<body>
<header>
<h1>Welham Nature Retreat</h1>
Gift Voucher Management
</header>
<main>${content}</main>
</body>
</html>`;
}

function login(message = '') {
  return page(`
<div class="panel login">
<h2>Owner Login</h2>
${message}
<form method="POST" action="/api/gift-voucher-admin">
<label for="password">Owner password</label>
<input id="password" name="password"
type="password" autocomplete="current-password" required>
<button type="submit">Open Gift Vouchers</button>
</form>
</div>`);
}

function connection() {
  return new Pool({
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
}

function dateText(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London'
  });
}

function actionForm(voucher, action, label, warning) {
  const ref = escapeHtml(voucher.reference);

  return `
<form class="actionForm" method="POST"
action="/api/gift-voucher-admin"
onsubmit="return confirm(${JSON.stringify(warning)})">
<input type="hidden" name="action" value="${action}">
<input type="hidden" name="reference" value="${ref}">
<label>Owner password to ${escapeHtml(label.toLowerCase())}</label>
<input name="password" type="password"
autocomplete="current-password" required>
<button type="submit">${escapeHtml(label)}</button>
</form>`;
}

function voucherCard(v) {
  const status = String(v.status || 'pending').toLowerCase();
  const payment = String(v.payment_status || 'awaiting').toLowerCase();

  let actions = '';

if (status === 'pending' && payment === 'awaiting') {
  actions += `
    <form class="actionForm"
          method="POST"
          action="/api/gift-voucher-print">
      <input type="hidden" name="reference"
             value="${escapeHtml(v.reference)}">
      <input type="hidden" name="preview" value="yes">
      <label>Owner password to preview voucher</label>
      <input type="password" name="password"
             autocomplete="current-password" required>
      <button type="submit">Preview Voucher</button>
    </form>`;
}

  if (payment !== 'paid' && status === 'pending') {
    actions += actionForm(
      v,
      'mark_paid',
      'Mark as Paid',
      'Have you verified the bank transfer for this voucher?'
    );
  }

  if (payment === 'paid' && status === 'pending') {
    actions += actionForm(
      v,
      'issue',
      'Issue Voucher',
      'Issue this voucher now?'
    );
  }

  if (status === 'issued') {
    actions += actionForm(
      v,
      'redeem',
      'Mark as Redeemed',
      'Has this voucher been used?'
    );
  }

if (status === 'issued' && payment === 'paid') {
  actions += `
    <form class="actionForm"
          method="POST"
          action="/api/gift-voucher-email"
          onsubmit="return confirm('Send this voucher email to the purchaser?')">
      <input type="hidden" name="reference"
             value="${escapeHtml(v.reference)}">
      <label>Owner password to email voucher</label>
      <input type="password" name="password"
             autocomplete="current-password" required>
      <button type="submit">Email Voucher</button>
    </form>`;
}

  return `
<div class="voucher">
<h3>${escapeHtml(v.reference)}</h3>
<p><strong>Voucher:</strong> ${escapeHtml(v.voucher_type)}</p>
<p><strong>Value:</strong> £${escapeHtml(Number(v.amount).toFixed(2))}</p>
<p><strong>Buyer:</strong> ${escapeHtml(v.buyer_name)}</p>
<p><strong>Email:</strong> ${escapeHtml(v.buyer_email)}</p>
<p><strong>Recipient:</strong> ${escapeHtml(v.recipient_name)}</p>
<p><strong>Message:</strong> ${escapeHtml(v.personal_message || 'None')}</p>
<p><strong>Requested:</strong> ${escapeHtml(dateText(v.created_at))}</p>
<p class="status">Payment: ${escapeHtml(payment)}</p>
<p class="status">Status: ${escapeHtml(status)}</p>
<p><strong>Issued:</strong> ${escapeHtml(dateText(v.issued_at))}</p>
<p><strong>Expires:</strong> ${escapeHtml(dateText(v.expires_at))}</p>
<p><strong>Redeemed:</strong> ${escapeHtml(dateText(v.redeemed_at))}</p>
${actions}
</div>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(login());
  }

  if (req.method !== 'POST') {
    return res.status(405).send(page('Method not allowed'));
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(
    body.password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(login(
      '<p class="message error">Incorrect owner password.</p>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page('Database unavailable'));
  }

  const pool = connection();

  try {
    const reference = String(body.reference || '');
    const action = String(body.action || '');

    if (action) {
      if (!/^WGV-[A-F0-9]{8}$/.test(reference)) {
        return res.status(400).send(page('Invalid voucher reference.'));
      }

      let result;

      if (action === 'mark_paid') {
        result = await pool.query(`
          UPDATE public.gift_vouchers
          SET payment_status='paid'
          WHERE reference=$1
            AND status='pending'
            AND payment_status='awaiting'
          RETURNING reference
        `, [reference]);

      } else if (action === 'issue') {
        result = await pool.query(`
          UPDATE public.gift_vouchers
          SET status='issued',
              issued_at=NOW(),
              expires_at=NOW() + INTERVAL '12 months'
          WHERE reference=$1
            AND status='pending'
            AND payment_status='paid'
          RETURNING reference
        `, [reference]);

      } else if (action === 'redeem') {
        result = await pool.query(`
          UPDATE public.gift_vouchers
          SET status='redeemed',
              redeemed_at=NOW()
          WHERE reference=$1
            AND status='issued'
            AND payment_status='paid'
            AND (expires_at IS NULL OR expires_at >= NOW())
          RETURNING reference
        `, [reference]);

      } else {
        return res.status(400).send(page('Unknown action.'));
      }

      if (result.rowCount !== 1) {
        return res.status(409).send(page(`
          <div class="panel">
          <p class="message error">
          Voucher could not be updated. Check its current status.
          </p>
          <a href="/api/gift-voucher-admin">Return to login</a>
          </div>
        `));
      }
    }

    const result = await pool.query(`
      SELECT reference, voucher_type, amount,
             buyer_name, buyer_email,
             recipient_name, personal_message,
             status, payment_status,
             created_at, issued_at,
             expires_at, redeemed_at
      FROM public.gift_vouchers
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const cards = result.rows.map(voucherCard).join('');

    return res.status(200).send(page(`
<div class="panel">
<h2>Gift Voucher Requests</h2>
<p>${result.rows.length} voucher record(s)</p>
<p><small>
Only mark a voucher paid after checking your bank.
Issue vouchers only after payment is confirmed.
Issuing currently records the voucher as issued;
it does not automatically email a printable voucher.
The expiry period is set to 12 months from issue.
</small></p>
</div>
<div class="panel">
${cards || '<p>No gift voucher requests yet.</p>'}
</div>
<p><a href="/api/calendar">Owner Booking Calendar</a></p>
    `));

  } catch (error) {
    console.error(
      'Gift voucher admin error:',
      error.code || error.message
    );

    return res.status(500).send(page(`
<div class="panel">
<p class="message error">Unable to load or update vouchers.</p>
</div>`));

  } finally {
    await pool.end();
  }
}
