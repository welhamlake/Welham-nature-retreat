
import pg from 'pg';
import { Resend } from 'resend';
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
<title>Welham Lake Gift Voucher Email</title>
<style>
body{
  background:#f3f5f1;
  color:#243328;
  font:16px Arial,sans-serif;
  padding:20px;
}
.panel{
  max-width:550px;
  margin:30px auto;
  background:white;
  padding:25px;
  border-radius:12px;
}
a{color:#234735}
</style>
</head>
<body>
<div class="panel">${content}</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(page(
      '<p>Method not allowed.</p>'
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
      '<h2>Incorrect owner password</h2>'
    ));
  }

  const reference = String(body.reference || '');

  if (!/^WGV-[A-F0-9]{8}$/.test(reference)) {
    return res.status(400).send(page(
      '<h2>Invalid voucher reference</h2>'
    ));
  }

  if (
    !process.env.DATABASE_URL ||
    !process.env.RESEND_API_KEY
  ) {
    return res.status(503).send(page(
      '<h2>Email service unavailable</h2>'
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

  try {
    const result = await pool.query(`
      SELECT reference, voucher_type, amount,
             buyer_name, buyer_email,
             recipient_name, personal_message,
             status, payment_status, expires_at
      FROM public.gift_vouchers
      WHERE reference=$1
      LIMIT 1
    `, [reference]);

    if (!result.rows.length) {
      return res.status(404).send(page(
        '<h2>Voucher not found</h2>'
      ));
    }

    const v = result.rows[0];

    if (
      v.status !== 'issued' ||
      v.payment_status !== 'paid' ||
      !v.expires_at ||
      new Date(v.expires_at).getTime() < Date.now()
    ) {
      return res.status(403).send(page(`
        <h2>Voucher cannot be emailed</h2>
        <p>It must be paid, issued and still valid.</p>
      `));
    }

    const expiry = new Date(v.expires_at)
      .toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Europe/London'
      });

    const safeReference = escapeHtml(v.reference);
    const safeRecipient = escapeHtml(v.recipient_name);
    const safeVoucher = escapeHtml(v.voucher_type);
    const safeMessage = escapeHtml(v.personal_message || '');
    const safeExpiry = escapeHtml(expiry);
    const safeAmount = escapeHtml(
      Number(v.amount).toFixed(2)
    );

    const html = `
<!doctype html>
<html>
<body style="margin:0;padding:20px;background:#f3f5f1;
font-family:Arial,sans-serif;color:#243328">
<div style="max-width:650px;margin:auto;background:white;
border-radius:12px;overflow:hidden">

<img src="https://www.welhamlakenature.co.uk/images/welham-gift-voucher.jpg"
alt="Welham Lake"
style="width:100%;display:block">

<div style="padding:25px">
<h2 style="color:#234735">Welham Lake Nature Retreat</h2>
<h1>Gift Voucher</h1>

<p>This gift voucher is for:</p>
<h2>${safeRecipient}</h2>

<p><strong>Experience:</strong> ${safeVoucher}</p>
<p><strong>Value:</strong> £${safeAmount}</p>

${safeMessage ? `
<p><em>${safeMessage}</em></p>` : ''}

<hr>

<p><strong>Voucher reference:</strong> ${safeReference}</p>
<p><strong>Valid until:</strong> ${safeExpiry}</p>

<p>To redeem your voucher, contact Welham Lake
and quote your voucher reference.</p>

<p>
<a href="https://www.welhamlakenature.co.uk">
www.welhamlakenature.co.uk
</a>
</p>
</div>
</div>
</body>
</html>`;

    const resend = new Resend(process.env.RESEND_API_KEY);

    const sent = await resend.emails.send({
      from: 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>',
      to: [v.buyer_email],
      replyTo: 'welhamlake@live.co.uk',
      subject: `Your Welham Lake Gift Voucher - ${reference}`,
      html
    });

    if (sent.error) {
      throw new Error(sent.error.message || 'Email failed');
    }

    return res.status(200).send(page(`
      <h2>Voucher email submitted</h2>
      <p>Voucher <strong>${safeReference}</strong>
      has been accepted by the email service for:</p>
      <p>${escapeHtml(v.buyer_email)}</p>
      <p>Delivery may take some time.</p>
      <p><a href="/api/gift-voucher-admin">
      Return to Gift Voucher Dashboard</a></p>
    `));

  } catch (error) {
    console.error(
      'Voucher email error:',
      error.code || error.message
    );

    return res.status(500).send(page(`
      <h2>Unable to send voucher</h2>
      <p>Please check the email delivery logs before trying again.</p>
    `));

  } finally {
    await pool.end();
  }
}
