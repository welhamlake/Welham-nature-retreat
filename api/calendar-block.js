
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

const experiences = [
  'Luxury Cabin',
  'Luxury Cabin Wildlife Hide',
  'Island Glamping',
  'Separate Wildlife Hide',
  'Island Wildlife Hides'
];

const hideExperiences = [
  'Luxury Cabin Wildlife Hide',
  'Separate Wildlife Hide',
  'Island Wildlife Hides'
];

const dayOnlyExperiences = [
  'Luxury Cabin Wildlife Hide',
  'Island Wildlife Hides'
];

const reasons = [
  'Maintenance',
  'Private use',
  'Airbnb booking',
  'Other'
];

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

function validDate(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(value + 'T12:00:00Z');

  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
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
.message{padding:12px;background:#e8f2e9;border-radius:8px}
.error{background:#fff0ed}
</style>
</head>
<body>
<header>
<h2>Welham Nature Retreat</h2>
Manage Blocked Dates
</header>
<main>${content}</main>
</body>
</html>`;
}

function form(message = '') {
  const options = experiences.map(x =>
    `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`
  ).join('');

  return page(`
    <div class="card">
      <h2>Block Dates</h2>
      ${message}

      <form method="POST" action="/api/calendar-block">
        <label for="experience">Experience</label>
        <select id="experience" name="experience" required>
          ${options}
        </select>

        <label for="session">Session to block</label>
        <select id="session" name="session" required>
          <option value="all">Whole day / All sessions</option>
          <option value="day">Daytime only (7am–5pm)</option>
          <option value="night">Overnight only (6pm–6am)</option>
        </select>

        <label for="start_date">First blocked date</label>
        <input id="start_date" type="date" name="start_date" required>

        <label for="end_date">Last blocked date</label>
        <input id="end_date" type="date" name="end_date" required>

        <label for="reason">Reason</label>
        <select id="reason" name="reason">
          <option>Maintenance</option>
          <option>Private use</option>
          <option>Airbnb booking</option>
          <option>Other</option>
        </select>

        <label for="password">Owner password</label>
        <input id="password" type="password" name="password" required>

        <button type="submit">Block Dates</button>
      </form>
    </div>

    <p><a href="/api/calendar">Return to calendar</a></p>

    <script>
      const experience = document.getElementById('experience');
      const session = document.getElementById('session');

      function updateSession() {
        const selected = experience.value;

        const isHide = ${JSON.stringify(hideExperiences)}.includes(selected);
        const dayOnly = ${JSON.stringify(dayOnlyExperiences)}.includes(selected);

        session.disabled = !isHide;
        session.replaceChildren();

        const options = dayOnly
          ? [
              ['all', 'Whole day / All sessions'],
              ['day', 'Daytime only (7am–5pm)']
            ]
          : [
              ['all', 'Whole day / All sessions'],
              ['day', 'Daytime only (7am–5pm)'],
              ['night', 'Overnight only (6pm–6am)']
            ];

        for (const [value, label] of options) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = label;
          session.appendChild(option);
        }

        session.value = 'all';
      }

      experience.addEventListener('change', updateSession);
      updateSession();
    </script>
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

  if (!passwordMatches(
    body.password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(
      form('<p class="message error">Incorrect password.</p>')
    );
  }

  const {
    experience,
    start_date,
    end_date,
    reason
  } = body;

  const session = hideExperiences.includes(experience)
    ? (body.session || 'all')
    : 'all';

  if (
    !experiences.includes(experience) ||
    !validDate(start_date) ||
    !validDate(end_date) ||
    end_date < start_date ||
    (Date.parse(end_date) - Date.parse(start_date)) / 86400000 > 366 ||
    !reasons.includes(reason) ||
    !['all', 'day', 'night'].includes(session) ||
    (dayOnlyExperiences.includes(experience) && session === 'night')
  ) {
    return res.status(400).send(
      form('<p class="message error">Invalid booking block details.</p>')
    );
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(
      form('<p class="message error">Database unavailable.</p>')
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
    await pool.query(
      `INSERT INTO public.blocked_dates
       (experience, start_date, end_date, reason, session)
       VALUES ($1, $2, $3, $4, $5)`,
      [experience, start_date, end_date, reason, session]
    );

    const sessionLabel = {
      all: 'Whole day / All sessions',
      day: 'Daytime only',
      night: 'Overnight only'
    }[session];

    return res.status(200).send(form(`
      <div class="message">
        <strong>Dates blocked successfully!</strong>
        <p>${escapeHtml(experience)}</p>
        <p>${escapeHtml(start_date)} to ${escapeHtml(end_date)}</p>
        <p>Session: ${escapeHtml(sessionLabel)}</p>
      </div>
    `));
  } catch (error) {
    console.error(
      'Calendar block error:',
      error.code || error.message
    );

    return res.status(500).send(
      form('<p class="message error">Unable to save blocked dates.</p>')
    );
  } finally {
    await pool.end();
  }
}
