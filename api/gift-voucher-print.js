
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

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

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function page(content, printable = false) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Lake Gift Voucher</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#e9ece7;
  font-family:Georgia,serif;
  color:#243328;
}
.controls{
  padding:18px;
  text-align:center;
  font-family:Arial,sans-serif;
}
button{
  background:#234735;
  color:white;
  border:0;
  padding:14px 24px;
  border-radius:7px;
  font-size:16px;
  cursor:pointer;
}
input{
  display:block;
  width:100%;
  padding:12px;
  margin:12px 0;
  border:1px solid #aaa;
  border-radius:6px;
  font-size:16px;
}
.login{
  max-width:420px;
  margin:40px auto;
  background:white;
  padding:25px;
  border-radius:12px;
}
.sheet{
  width:297mm;
  height:210mm;
  margin:20px auto;
  position:relative;
  overflow:hidden;
  background:#24412e;
  box-shadow:0 5px 25px #0003;
}
.photo{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
}
.overlay{
  position:absolute;
  inset:0;
  background:linear-gradient(
    90deg,
    rgba(12,35,23,.88),
    rgba(12,35,23,.55) 65%,
    rgba(12,35,23,.28)
  );
}
.content{
  position:relative;
  z-index:1;
  height:100%;
  padding:20mm;
  color:white;
  display:flex;
  flex-direction:column;
  justify-content:center;
}
.brand{
  font:700 17pt Arial,sans-serif;
  letter-spacing:3px;
  text-transform:uppercase;
}
.subtitle{
  font:12pt Arial,sans-serif;
  letter-spacing:3px;
  margin-top:7px;
}
h1{
  font-size:46pt;
  font-weight:normal;
  margin:20mm 0 12mm;
}
.recipient{
  font-size:24pt;
  margin:5mm 0;
}
.experience{
  font-size:20pt;
  margin:5mm 0;
  max-width:235mm;
}
.message{
  font-size:15pt;
  font-style:italic;
  margin:7mm 0;
  max-width:210mm;
  white-space:pre-wrap;
}
.footer{
  margin-top:auto;
  font:11pt Arial,sans-serif;
  line-height:1.8;
}
@page{
  size:A4 landscape;
  margin:0;
}
@media print{
  html,body{
    width:297mm;
    height:210mm;
    margin:0;
    padding:0;
    background:white;
    print-color-adjust:exact;
    -webkit-print-color-adjust:exact;
  }
  .controls{display:none!important}
  .sheet{
    width:297mm;
    height:210mm;
    margin:0;
    box-shadow:none;
    break-inside:avoid;
  }
}
@media screen and (max-width:1150px){
  .sheet{
    transform-origin:top left;
    transform:scale(var(--scale, .35));
    margin:10px 0;
  }
}
</style>
</head>
<body>
${content}
${printable ? `<script>
function resizeVoucher(){
  const sheet=document.querySelector('.sheet');
  if(!sheet)return;
  const width=1122.5;
  const scale=Math.min(1,(window.innerWidth-20)/width);
  sheet.style.setProperty('--scale',scale);
  sheet.style.marginBottom=
    ((793.7*scale)-793.7+20)+'px';
}
window.addEventListener('resize',resizeVoucher);
resizeVoucher();
</script>` : ''}
</body>
</html>`;
}

function login(reference, message = '') {
  return page(`
<div class="login">
<h2>Print Gift Voucher</h2>
${message}
<form method="POST" action="/api/gift-voucher-print">
<input type="hidden" name="reference"
value="${escapeHtml(reference)}">
<label>Owner password</label>
<input type="password" name="password"
autocomplete="current-password" required>
<button type="submit">Open Printable Voucher</button>
</form>
</div>`);
}

function dateText(value) {
  if (!value) return 'Not set';
  return new Date(value).toLocaleDateString('en-GB', {
    day:'numeric',
    month:'long',
    year:'numeric',
    timeZone:'Europe/London'
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Type','text/html; charset=utf-8');

  const reference = String(
    req.method === 'POST'
      ? (req.body?.reference || '')
      : (req.query?.reference || '')
  );

  if (!/^WGV-[A-F0-9]{8}$/.test(reference)) {
    return res.status(400).send(page(`
      <div class="login">
      <h2>Invalid voucher reference</h2>
      <p>Open a voucher from your owner dashboard.</p>
      </div>`));
  }

  if (req.method === 'GET') {
    return res.status(200).send(login(reference));
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
      reference,
      '<p>Incorrect owner password.</p>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page('Database unavailable'));
  }

  const pool = new Pool({
    connectionString:process.env.DATABASE_URL,
    ssl:{
      rejectUnauthorized:true,
      ...(process.env.SUPABASE_CA_CERT
        ? {ca:process.env.SUPABASE_CA_CERT}
        : {})
    },
    max:1,
    connectionTimeoutMillis:5000
  });

  try {
    const result = await pool.query(`
      SELECT reference,voucher_type,amount,
             recipient_name,personal_message,
             status,payment_status,expires_at
      FROM public.gift_vouchers
      WHERE reference=$1
      LIMIT 1
    `,[reference]);

    if (!result.rows.length) {
      return res.status(404).send(page(
        '<div class="login">Voucher not found.</div>'
      ));
    }

    const v = result.rows[0];

    
if (
  (v.status !== 'issued' ||
   v.payment_status !== 'paid') &&
  !(body.preview === 'yes' &&
    v.status === 'pending' &&
    v.payment_status === 'awaiting')
) {

      return res.status(403).send(page(`
        <div class="login">
        <h2>Voucher not yet issued</h2>
        <p>Confirm payment and issue the voucher
        in your owner dashboard first.</p>
        </div>`));
    }

if (status === 'issued') {
  actions += `
    <p>
      <a class="action"
         href="/api/gift-voucher-print?reference=${encodeURIComponent(v.reference)}">
        🖨️ Print Voucher
      </a>
    </p>`;
}

    const voucherHtml = `
<div class="controls">
<button onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="sheet">
<img class="photo"
src="/images/welham-gift-voucher.jpg"
alt="Welham Lake">
<div class="overlay"></div>
<div class="content">
  <div class="brand">Welham Lake</div>
  <div class="subtitle">Nature Retreat</div>

  <h1>Gift Voucher</h1>

  <div class="recipient">
    For ${escapeHtml(v.recipient_name)}
  </div>

  <div class="experience">
    ${escapeHtml(v.voucher_type)}
  </div>

  ${v.personal_message ? `
  <div class="message">
    "${escapeHtml(v.personal_message)}"
  </div>` : ''}

  <div class="footer">
    Voucher value: £${escapeHtml(Number(v.amount).toFixed(2))}<br>
    Reference: ${escapeHtml(v.reference)}<br>
    Valid until: ${escapeHtml(dateText(v.expires_at))}<br>
    www.welhamlakenature.co.uk
  </div>
</div>
</div>`;

    return res.status(200).send(page(voucherHtml,true));

  } catch (error) {
    console.error(
      'Voucher print error:',
      error.code || error.message
    );
    return res.status(500).send(page(
      '<div class="login">Unable to load voucher.</div>'
    ));
  } finally {
    await pool.end();
  }
}
