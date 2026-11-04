
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

function page(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Manage Blocked Dates | Welham</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:22px}
main{max-width:550px;margin:auto;padding:18px}
.card{background:white;padding:20px;border-radius:12px;margin:12px 0}
input,select,button{font:inherit;width:100%;padding:13px;margin:8px 0;border-radius:8px}
input,select{border:1px solid #aaa}
button{background:#234735;color:white;border:0;font-weight:bold}
a{color:#234735}
</style>
</head>
<body>
<header><h2>Welham Nature Retreat</h2>Manage Blocked Dates</header>
<main>${content}</main>
</body></html>`;
}

const experiences = [
  'Luxury Cabin',
  'Island Glamping',
  'Separate Wildlife Hide',
  'Island Wildlife Hides'
];

function form(message = '') {
  const options = experiences.map(x =>
    `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`
  ).join('');

  return page(`
    <div class="card">
      <h2>Block Dates</h2>
      ${message}
      <form method="POST" action="/api/calendar-block">
        <label>Experience</label>
        <select name="experience" required>${options}</select>
        <label>First blocked date</label>
        <input type="date" name="start_date" required>
        <label>Last blocked date</label>
        <input type="date" name="end_date" required>
        <label>Reason</label>
        <select name="reason">
          <option>Maintenance</option>
          <option>Private use</option>
          <option>Airbnb booking</option>
          <option>Other</option>
        </select>
        <label>Owner password</label>
        <input type="password" name="password" required>
        <button type="submit">Block Dates</button>
      </form>
    </div>
    <p><a href="/api/calendar">Return to calendar</a></p>
  `);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(form());
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(body.password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(form('<p>Incorrect password.</p>'));
  }

  const { experience, start_date, end_date, reason } = body;
  const validDate = x =>
    typeof x === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    !Number.isNaN(Date.parse(x)) &&
    new Date(x).toISOString().slice(0, 10) === x;

  if (!experiences.includes(experience) ||
      !validDate(start_date) ||
      !validDate(end_date) ||
      end_date < start_date ||
      (Date.parse(end_date) - Date.parse(start_date)) / 86400000 > 366 ||
      !['Maintenance','Private use','Airbnb booking','Other'].includes(reason)) {
    return res.status(400).send(form('<p>Invalid dates or experience.</p>'));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(form('<p>Database unavailable.</p>'));
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
    await pool.query(
      `INSERT INTO public.blocked_dates
       (experience, start_date, end_date, reason)
       VALUES ($1, $2, $3, $4)`,
      [experience, start_date, end_date, reason]
    );

    return res.status(200).send(form(
      `<p><strong>Dates blocked successfully!</strong></p>
       <p>${escapeHtml(experience)}:
       ${escapeHtml(start_date)} to ${escapeHtml(end_date)}</p>`
    ));
  } catch (error) {
    console.error('Calendar block error:', error.code || error.message);
    return res.status(500).send(form(
      '<p>Unable to save blocked dates.</p>'
    ));
  } finally {
    await pool.end();
  }
}
