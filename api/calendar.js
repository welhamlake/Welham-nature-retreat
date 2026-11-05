
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

const names = {
  cabin: 'Luxury Cabin',
  cabin_hide: 'Luxury Cabin Wildlife Hide',
  island: 'Island Glamping',
  hide: 'Separate Wildlife Hide',
  island_hides: 'Island Wildlife Hides'
};

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function dateOnly(value) {
  if (!value) return '';
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function page(content) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Owner Booking Calendar</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:15px Arial,sans-serif}
header{background:#234735;color:white;padding:20px}
header h1{margin:0;font-size:23px}
main{max-width:1000px;margin:auto;padding:12px}
.panel{background:white;border-radius:12px;padding:15px;margin:12px 0}
input,button{font:inherit;padding:12px;border-radius:8px}
input{width:100%;border:1px solid #aaa;margin:10px 0}
button,.action{background:#234735;color:white;border:0;font-weight:bold;cursor:pointer}
.action{display:inline-block;text-decoration:none;padding:12px;border-radius:8px;margin:5px 0}
.login button{width:100%}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.toolbar button{padding:10px}
#monthTitle{font-size:19px;text-align:center}
.filters{display:flex;flex-wrap:wrap;gap:7px}
.filters button{background:#e5eae4;color:#234735}
.filters button.active{background:#234735;color:white}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;font-size:13px}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:4px}
.green{background:#3e9a60}
.amber{background:#e5a332}
.blue{background:#4189cc}
.red{background:#d65757}
.grey{background:#c9d0c9}
.weekdays,.calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.weekdays{text-align:center;font-weight:bold;font-size:12px}
.weekdays div{padding:9px 0}
.day{min-height:77px;border:1px solid #e4e8e2;background:white;padding:5px 3px;overflow:hidden;cursor:pointer}
.day.empty{background:#f3f5f1;cursor:default}
.day.today{outline:2px solid #234735;outline-offset:-2px}
.daynum{font-weight:bold;font-size:13px;margin-bottom:5px}
.event{display:block;border-radius:4px;padding:4px 3px;margin:3px 0;font-size:10px;overflow-wrap:anywhere;color:#142b1d}
.event.paid{background:#bce7c8}
.event.pending{background:#ffe1a0}
.event.awaiting{background:#c5dffc}
.event.other{background:#dce1dc}
.event.blocked{background:#f6bcbc;color:#741d1d}
.details{margin-top:12px}
.booking{padding:12px;border:1px solid #ddd;border-radius:8px;margin:8px 0;overflow-wrap:anywhere}
.booking p{margin:7px 0}
.remove{background:#b93838;color:white;padding:10px 15px;margin-top:10px}
.removeForm,.manageForm{margin-top:12px}
.removeForm label,.manageForm label{display:block;font-weight:bold}
.removeForm input,.manageForm input{max-width:360px}
.manageForm{padding-top:10px;border-top:1px solid #ddd}
.manageForm button{margin:5px 6px 5px 0}
.release{background:#b93838}
.message{padding:15px;border-radius:8px;background:#e7f2e9}
.error{background:#fff0ed}
small{color:#627064}
@media(min-width:650px){
  .day{min-height:110px;padding:7px}
  .event{font-size:12px}
}
</style></head><body>
<header><h1>Welham Nature Retreat</h1>Owner Booking Calendar</header>
<main>${content}</main></body></html>`;
}

function login(message = '') {
  return page(`<div class="panel login">
<h2>Calendar Login</h2>${message}
<form method="POST" action="/api/calendar">
<label for="password">Owner password</label>
<input id="password" name="password" type="password"
autocomplete="current-password" required>
<button type="submit">Open Calendar</button>
</form></div>`);
}

function poolConnection() {
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') return res.status(200).send(login());
  if (req.method !== 'POST') return res.status(405).send(page('Method not allowed'));

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(body.password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(login(
      '<p class="message error">Incorrect owner password.</p>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page('Database unavailable'));
  }

  const pool = poolConnection();

  try {
    if (body.action === 'remove_block') {
      const id = String(body.block_id || '');
      const experience = String(body.experience || '');
      const start = String(body.start_date || '');
      const end = String(body.end_date || '');

      if (
        !/^[1-9]\d*$/.test(id) ||
        !experiences.includes(experience) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end)
      ) {
        return res.status(400).send(page(
          '<div class="panel">Invalid block details. No changes made.</div>'
        ));
      }

      const deleted = await pool.query(`
        DELETE FROM public.blocked_dates
        WHERE id=$1
          AND experience=$2
          AND start_date=$3::date
          AND end_date=$4::date
        RETURNING id
      `, [id, experience, start, end]);

      if (deleted.rowCount !== 1) {
        return res.status(404).send(page(`
          <div class="panel">
            <p class="message error">Block not found. No changes made.</p>
            <a href="/api/calendar">Return to calendar</a>
          </div>
        `));
      }

      return res.status(200).send(page(`
        <div class="panel">
          <h2>Block removed successfully</h2>
          <p class="message">${escapeHtml(experience)}:
          ${escapeHtml(start)} to ${escapeHtml(end)}</p>
          <p>Only this selected block was removed.</p>
          <a class="action" href="/api/calendar">Return to calendar</a>
        </div>
      `));
    }

    const [bookingResult, blockResult] = await Promise.all([
      pool.query(`
        SELECT request_reference, guest_name, type,
               start_date, end_date, session, status,
               payment_status, payment_due_at, total_pence
        FROM public.bookings
        WHERE start_date >= CURRENT_DATE - INTERVAL '2 years'
          AND start_date < CURRENT_DATE + INTERVAL '3 years'
        ORDER BY start_date ASC LIMIT 2000
      `),
      pool.query(`
        SELECT id, experience, start_date, end_date, reason, session
        FROM public.blocked_dates
        WHERE end_date >= CURRENT_DATE - INTERVAL '2 years'
          AND start_date < CURRENT_DATE + INTERVAL '3 years'
        ORDER BY start_date ASC LIMIT 2000
      `)
    ]);

    const bookings = bookingResult.rows.map(b => ({
      reference: b.request_reference,
      guest: b.guest_name,
      type: b.type,
      start: dateOnly(b.start_date),
      end: dateOnly(b.end_date) || dateOnly(b.start_date),
      session: b.session || '',
      status: b.status,
      payment: b.payment_status,
      paymentDue: b.payment_due_at
        ? new Date(b.payment_due_at).toISOString()
        : '',
      total: (Number(b.total_pence) / 100).toFixed(2)
    }));

    const blocks = blockResult.rows.map(b => ({
      id: String(b.id),
      experience: b.experience,
      start: dateOnly(b.start_date),
      end: dateOnly(b.end_date),
      reason: b.reason || 'Blocked',
      session: b.session || 'all'
    }));

    return res.status(200).send(page(`
<div class="panel">
  <div class="toolbar">
    <button type="button" id="prev">‹ Previous</button>
    <strong id="monthTitle"></strong>
    <button type="button" id="next">Next ›</button>
  </div>
  <div class="legend">
    <span><i class="dot green"></i>Paid</span>
    <span><i class="dot amber"></i>Pending</span>
    <span><i class="dot blue"></i>Awaiting payment</span>
    <span><i class="dot red"></i>Blocked</span>
    <span><i class="dot grey"></i>Other</span>
  </div>
  <p><a class="action" href="/api/calendar-block">+ Block Dates</a></p>
</div>
<div class="panel"><div class="filters" id="filters"></div></div>
<div class="panel">
  <div class="weekdays">
    <div>Mon</div><div>Tue</div><div>Wed</div>
    <div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
  </div>
  <div class="calendar" id="calendar"></div>
  <div class="details" id="details"></div>
</div>
<p><small>Owner-only calendar. Always verify a bank transfer before marking a booking paid.
Release unpaid approved bookings only after the payment deadline and a manual bank check.</small></p>
<script id="bookingData" type="application/json">${safeJson(bookings)}</script>
<script id="blockData" type="application/json">${safeJson(blocks)}</script>
<script id="experienceData" type="application/json">${safeJson(experiences)}</script>
<script id="nameData" type="application/json">${safeJson(names)}</script>
<script>
(() => {
const bookings = JSON.parse(document.getElementById('bookingData').textContent);
const blocks = JSON.parse(document.getElementById('blockData').textContent);
const experiences = JSON.parse(document.getElementById('experienceData').textContent);
const names = JSON.parse(document.getElementById('nameData').textContent);

const calendar = document.getElementById('calendar');
const details = document.getElementById('details');
const filters = document.getElementById('filters');
const title = document.getElementById('monthTitle');

const now = new Date();
let year = now.getFullYear();
let month = now.getMonth();
let selectedFilter = 'All';

function category(type) {
  const value = String(type || '');
  if (names[value]) return names[value];
  if (experiences.includes(value)) return value;

  const t = value.toLowerCase();

  if (t.includes('cabin') && t.includes('hide')) {
    return 'Luxury Cabin Wildlife Hide';
  }
  if (t.includes('cabin') || t.includes('luxury')) {
    return 'Luxury Cabin';
  }
  if (t.includes('island') &&
      (t.includes('hide') || t.includes('wildlife'))) {
    return 'Island Wildlife Hides';
  }
  if (t.includes('island') || t.includes('bell') ||
      t.includes('glamp')) {
    return 'Island Glamping';
  }
  if (t.includes('hide') || t.includes('wildlife')) {
    return 'Separate Wildlife Hide';
  }

  return value;
}

function active(b) {
  return !['declined', 'cancelled', 'expired']
    .includes(String(b.status).toLowerCase());
}

function visibleType(type) {
  return selectedFilter === 'All' ||
    category(type) === selectedFilter;
}

function colour(b) {
  if (b.payment === 'paid') return 'paid';
  if (b.status === 'pending') return 'pending';
  if (b.status === 'approved') return 'awaiting';
  return 'other';
}

function bookingsOn(date) {
  return bookings.filter(b =>
    active(b) &&
    visibleType(b.type) &&
    date >= b.start &&
    date <= b.end
  );
}

function blocksOn(date) {
  return blocks.filter(b =>
    visibleType(b.experience) &&
    date >= b.start &&
    date <= b.end
  );
}

function addText(parent, tag, value) {
  const el = document.createElement(tag);
  el.textContent = value;
  parent.appendChild(el);
  return el;
}

function addHidden(form, name, value) {
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = value;
  form.appendChild(input);
}

function sessionLabel(session) {
  if (session === 'day') return 'Daytime';
  if (session === 'night') return 'Overnight';
  return 'Whole day';
}

function addOwnerForm(parent, b, action, buttonText, warning) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/booking-manage';
  form.className = 'manageForm';

  addHidden(form, 'action', action);
  addHidden(form, 'request_reference', b.reference);

  const label = addText(form, 'label',
    'Owner password to ' + buttonText.toLowerCase());

  const password = document.createElement('input');
  password.type = 'password';
  password.name = 'password';
  password.autocomplete = 'current-password';
  password.required = true;
  label.appendChild(password);

  const button = document.createElement('button');
  button.type = 'submit';

  if (action === 'release_booking') {
    button.className = 'release';
  }

  button.textContent = buttonText;
  form.appendChild(button);

  form.addEventListener('submit', event => {
    if (!window.confirm(warning + ' Booking ' + b.reference + '?')) {
      event.preventDefault();
    }
  });

  parent.appendChild(form);
}

function showDetails(date) {
  details.replaceChildren();

  addText(details, 'h3',
    new Date(date + 'T12:00:00').toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })
  );

  const foundBookings = bookingsOn(date);
  const foundBlocks = blocksOn(date);

  if (!foundBookings.length && !foundBlocks.length) {
    addText(details, 'p',
      'No bookings or manual blocks recorded for this date.');
  }

  foundBlocks.forEach(b => {
    const div = document.createElement('div');
    div.className = 'booking';
    div.style.borderLeft = '5px solid #d65757';

    addText(div, 'strong', 'BLOCKED — ' + category(b.experience));
    addText(div, 'p', sessionLabel(b.session) + ' | ' + b.reason);
    addText(div, 'p', b.start + ' to ' + b.end);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/calendar';
    form.className = 'removeForm';

    addHidden(form, 'action', 'remove_block');
    addHidden(form, 'block_id', b.id);
    addHidden(form, 'experience', b.experience);
    addHidden(form, 'start_date', b.start);
    addHidden(form, 'end_date', b.end);

    const label = addText(form, 'label',
      'Owner password to remove this block');

    const password = document.createElement('input');
    password.type = 'password';
    password.name = 'password';
    password.autocomplete = 'current-password';
    password.required = true;
    label.appendChild(password);

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'remove';
    button.textContent = 'Remove Block';
    form.appendChild(button);

    form.addEventListener('submit', event => {
      if (!window.confirm(
        'Remove this block for ' + b.experience +
        ' (' + b.start + ' to ' + b.end + ')?'
      )) event.preventDefault();
    });

    div.appendChild(form);
    details.appendChild(div);
  });

  foundBookings.forEach(b => {
    const div = document.createElement('div');
    div.className = 'booking';

    const lines = [
      category(b.type),
      'Guest: ' + b.guest,
      'Reference: ' + b.reference,
      'Dates: ' + b.start + ' to ' + b.end,
      'Session: ' + (b.session || '—'),
      'Status: ' + b.status,
      'Payment: ' + b.payment,
      'Total: £' + b.total
    ];

    lines.forEach((line, i) =>
      addText(div, i === 0 ? 'strong' : 'p', line)
    );

    if (b.paymentDue) {
      addText(div, 'p',
        'Payment deadline: ' +
        new Date(b.paymentDue).toLocaleString('en-GB', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Europe/London'
        }) + ' (UK time)'
      );
    }

    if (
      String(b.status).toLowerCase() === 'approved' &&
      String(b.payment).toLowerCase() !== 'paid'
    ) {
      addOwnerForm(
        div, b, 'mark_paid', 'Mark as Paid',
        'Only continue if you have verified the full bank transfer. Mark as PAID and CONFIRMED'
      );

      if (
        b.paymentDue &&
        new Date(b.paymentDue).getTime() <= Date.now()
      ) {
        addOwnerForm(
          div, b, 'release_booking', 'Release Booking',
          'Only continue if you checked the bank and no payment arrived. RELEASE the dates for'
        );
      } else {
        addText(div, 'p',
          'Release Booking becomes available after the payment deadline.');
      }
    }

    details.appendChild(div);
  });

  details.scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });
}

const types = [
  'All',
  ...new Set([
    ...experiences,
    ...bookings.map(b => category(b.type)).filter(Boolean),
    ...blocks.map(b => category(b.experience)).filter(Boolean)
  ])
];

types.forEach(type => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = type === 'All' ? 'All Experiences' : type;
  button.dataset.filter = type;

  button.addEventListener('click', () => {
    selectedFilter = type;
    render();
  });

  filters.appendChild(button);
});

function render() {
  [...filters.children].forEach(button =>
    button.classList.toggle(
      'active',
      button.dataset.filter === selectedFilter
    )
  );

  title.textContent = new Date(year, month, 1)
    .toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric'
    });

  calendar.replaceChildren();
  details.replaceChildren();

  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < offset; i++) {
    const blank = document.createElement('div');
    blank.className = 'day empty';
    calendar.appendChild(blank);
  }

  for (let day = 1; day <= days; day++) {
    const date = [
      year,
      String(month + 1).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-');

    const cell = document.createElement('div');
    cell.className = 'day';

    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-');

    if (date === today) cell.classList.add('today');

    addText(cell, 'div', String(day)).className = 'daynum';

    blocksOn(date).forEach(b => {
      const event = addText(
        cell, 'span',
        'Blocked: ' + category(b.experience) +
        ' (' + sessionLabel(b.session) + ')'
      );
      event.className = 'event blocked';
    });

    bookingsOn(date).forEach(b => {
      const event = addText(
        cell, 'span',
        category(b.type) + (b.session ? ' ' + b.session : '')
      );
      event.className = 'event ' + colour(b);
    });

    cell.addEventListener('click', () => showDetails(date));
    calendar.appendChild(cell);
  }
}

document.getElementById('prev').addEventListener('click', () => {
  month--;
  if (month < 0) {
    month = 11;
    year--;
  }
  render();
});

document.getElementById('next').addEventListener('click', () => {
  month++;
  if (month > 11) {
    month = 0;
    year++;
  }
  render();
});

render();
})();
</script>`));

  } catch (error) {
    console.error('Calendar error:', error.code || error.message);
    return res.status(500).send(page(
      '<div class="panel">Unable to update or load calendar.</div>'
    ));
  } finally {
    await pool.end();
  }
}
