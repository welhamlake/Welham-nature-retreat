
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

const TYPES = {
  cabin: 'Luxury Cabin',
  cabin_hide: 'Luxury Cabin Wildlife Hide',
  hide: 'Separate Wildlife Hide',
  island: 'Island Glamping',
  island_hides: 'Island Wildlife Hides'
};

const BLOCK_NAMES = {
  cabin: ['Luxury Cabin'],
  cabin_hide: ['Luxury Cabin Wildlife Hide', 'Luxury Cabin'],
  hide: ['Separate Wildlife Hide', 'Woodland Wildlife Pond Hide', 'hide'],
  island: ['Island Glamping'],
  island_hides: ['Island Wildlife Hides', 'Island Glamping']
};

const RELATED = {
  cabin: ['cabin', 'cabin_hide'],
  cabin_hide: ['cabin', 'cabin_hide'],
  hide: ['hide'],
  island: ['island', 'island_hides'],
  island_hides: ['island', 'island_hides']
};

function esc(x) {
  return String(x ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function passwordOK(input) {
  const expected = process.env.BOOKING_ADMIN_PASSWORD;
  if (typeof input !== 'string' || !expected) return false;
  return timingSafeEqual(
    createHash('sha256').update(input).digest(),
    createHash('sha256').update(expected).digest()
  );
}

function dateString(x) {
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  return String(x ?? '').slice(0, 10);
}

function validDate(x) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const d = new Date(x + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === x;
}

function addDays(x, n) {
  const d = new Date(x + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round(
    (Date.parse(b + 'T12:00:00Z') -
     Date.parse(a + 'T12:00:00Z')) / 86400000
  );
}

function money(pence) {
  return '£' + (Number(pence) / 100).toFixed(2);
}

function page(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Edit Booking | Welham Nature Retreat</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:22px}
main{max-width:580px;margin:auto;padding:18px}
.card{background:white;padding:20px;border-radius:12px;margin:12px 0}
input,select,button{font:inherit;width:100%;padding:12px;margin:8px 0;border-radius:8px}
input,select{border:1px solid #aaa}
button{background:#234735;color:white;border:0;font-weight:bold}
label{display:block;margin-top:12px;font-weight:bold}
a{color:#234735}
.message{background:#e8f2e9;padding:14px;border-radius:8px}
.error{background:#fff0ed}
small{color:#555}
</style>
</head>
<body>
<header><h2>Welham Nature Retreat</h2>Edit Booking</header>
<main>${content}
<p><a href="/api/calendar">Return to owner calendar</a></p>
</main>
</body>
</html>`;
}

function login(reference = '', message = '') {
  return page(`<div class="card">
<h2>Find Booking</h2>
${message}
<form method="POST" action="/api/booking-edit">
<input type="hidden" name="action" value="view">
<label>Booking reference</label>
<input name="reference" value="${esc(reference)}" required>
<label>Owner password</label>
<input type="password" name="password" required>
<button>Open Booking</button>
</form>
</div>`);
}

function editForm(b, message = '') {
  const type = b.type;
  const hide = ['hide', 'cabin_hide', 'island_hides'].includes(type);
  const session = String(b.session || 'day');
  const sessionOptions = hide
    ? (type === 'hide' ? ['day', 'night'] : ['day'])
    : [];

  return page(`<div class="card">
<h2>Edit ${esc(TYPES[type])}</h2>
${message}
<p><strong>Reference:</strong> ${esc(b.request_reference)}</p>
<p><strong>Status:</strong> ${esc(b.status)}</p>
<p><strong>Payment:</strong> ${esc(b.payment_status)}</p>
<p><strong>Current total:</strong> ${money(b.total_pence)}</p>

<div id="price-preview" class="message">
  Updated price will appear here.
</div>

<form method="POST" action="/api/booking-edit">
<input type="hidden" name="action" value="save">
<input type="hidden" name="reference" value="${esc(b.request_reference)}">

<label>Guest name</label>
<input name="guest_name" maxlength="150" value="${esc(b.guest_name)}" required>

<label>Email address</label>
<input type="email" name="email" value="${esc(b.email)}" required>

<label>Telephone</label>
<input name="phone" maxlength="50" value="${esc(b.phone)}">

<label>Number of guests</label>
<input type="number" name="guests" min="1" max="2" value="${esc(b.guests)}" required>

<label>Arrival / first session date</label>
<input type="date" name="start_date" value="${esc(dateString(b.start_date))}" required>

<label>Departure / last session date</label>
<input type="date" name="end_date" value="${esc(dateString(b.end_date))}" required>

${hide ? `<label>Wildlife hide session</label>
<select name="session">
${sessionOptions.map(s => `<option value="${s}" ${session === s ? 'selected' : ''}>${s === 'day' ? 'Daytime' : 'Overnight'}</option>`).join('')}
</select>` : `<input type="hidden" name="session" value="${esc(b.session || 'all')}">`}

<p><small>Paid bookings keep their payment status. Any price difference must be settled manually.</small></p>

<label>Owner password to confirm changes</label>
<input type="password" name="password" required>

<button type="submit">Save Changes &amp; Email Customer</button>
</form>

<script>
(() => {
  const form = document.querySelector('form[action="/api/booking-edit"]');
  const preview = document.getElementById('price-preview');
  const original = ${Number(b.total_pence)};
  const type = '${type}';

  const pounds = pence =>
    '£' + (pence / 100).toFixed(2);

  function updatePrice() {
    const start = form.elements.start_date.value;
    const end = form.elements.end_date.value;
    const guests = Number(form.elements.guests.value);

    const startDate = new Date(start + 'T12:00:00Z');
    const endDate = new Date(end + 'T12:00:00Z');
    const days = Math.round((endDate - startDate) / 86400000);

    if (!start || !end || !Number.isFinite(days) ||
        days < 0 || guests < 1 || guests > 2) {
      preview.textContent = 'Please enter valid dates and guest numbers.';
      return;
    }

    let total;

    if (type === 'cabin') {
      total = days * 30000;
    } else if (type === 'island') {
      total = days * 25000;
    } else if (type === 'island_hides') {
      total = (days + 1) * 10000;
    } else {
      total = (days + 1) * (guests === 1 ? 7500 : 10000);
    }

    const difference = total - original;

    preview.textContent =
      'Original price: ' + pounds(original) +
      ' | Updated price: ' + pounds(total) +
      ' | ' + (
        difference > 0
          ? 'Extra to collect: ' + pounds(difference)
          : difference < 0
            ? 'Refund/credit to arrange: ' + pounds(-difference)
            : 'No price difference'
      );
  }

  form.addEventListener('input', updatePrice);
  form.addEventListener('change', updatePrice);
  updatePrice();
})();
</script>

</div>`);
}

function calculate(type, start, end, guests) {
  const count = daysBetween(start, end);
  if (['cabin', 'island'].includes(type)) {
    return count * (type === 'cabin' ? 30000 : 25000);
  }
  const sessions = count + 1;
  if (type === 'island_hides') return sessions * 10000;
  return sessions * (guests === 1 ? 7500 : 10000);
}

function checkRules(type, start, end, session, guests) {
  if (!TYPES[type] || !validDate(start) || !validDate(end)) {
    return 'Invalid booking dates.';
  }
  if (!Number.isInteger(guests) || guests < 1 || guests > 2) {
    return 'Guest number must be one or two.';
  }
  const n = daysBetween(start, end);
  if (n < 0) return 'Departure must not be before arrival.';

  if (['cabin', 'island'].includes(type)) {
    if (n < 2 || n > 60) return 'Accommodation requires 2–60 nights.';
    if (type === 'cabin') {
      const weekday = new Date(start + 'T12:00:00Z').getUTCDay();
      if (weekday === 0 || weekday === 6) {
        return 'Luxury Cabin arrivals must be Monday to Friday.';
      }
    }
    if (type === 'island' && start < '2027-03-01') {
      return 'Island Glamping opens in March 2027.';
    }
  } else {
    if (type === 'hide' && (n > 6 || !['day', 'night'].includes(session))) {
      return 'Separate hide bookings allow 1–7 day or overnight sessions.';
    }
    if (type !== 'hide' && (n !== 0 || session !== 'day')) {
      return 'This wildlife hide allows one daytime session per booking.';
    }
    if (type !== 'hide') {
      const limit = addDays(new Date().toISOString().slice(0, 10), 14);
      if (start > limit) return 'Hide bookings are limited to 14 days ahead.';
    }
  }
  if (start < new Date().toISOString().slice(0, 10)) {
    return 'Booking dates cannot be in the past.';
  }
  return null;
}

function rangeFor(type, start, end) {
  return {
    from: start,
    to: ['cabin', 'island'].includes(type)
      ? end
      : addDays(end, 1)
  };
}

function overlaps(a, b) {
  return a.from < b.to && b.from < a.to;
}

function sessionClash(a, b) {
  return a === 'all' || b === 'all' || a === b;
}

async function checkAvailability(client, b, start, end, session) {
  const target = rangeFor(b.type, start, end);

  const others = await client.query(
    `SELECT id, type, start_date, end_date, session,
            status, expires_at
     FROM public.bookings
     WHERE id <> $1 AND type = ANY($2::text[])
       AND status = ANY($3::text[])`,
    [b.id, RELATED[b.type], ACTIVE]
  );

  for (const other of others.rows) {
    if (other.status === 'pending' &&
        other.expires_at &&
        new Date(other.expires_at).getTime() <= Date.now()) continue;

    const otherRange = rangeFor(
      other.type,
      dateString(other.start_date),
      dateString(other.end_date)
    );

    if (!overlaps(target, otherRange)) continue;

    if (b.type !== other.type ||
        !['hide'].includes(b.type) ||
        sessionClash(session, other.session || 'all')) {
      return 'These dates clash with another booking.';
    }
  }

  const blocks = await client.query(
    `SELECT experience, start_date, end_date, session
     FROM public.blocked_dates
     WHERE experience = ANY($1::text[])
       AND start_date <= $3::date
       AND end_date >= $2::date`,
    [BLOCK_NAMES[b.type], start, end]
  );

  for (const block of blocks.rows) {
    if (!['hide'].includes(b.type) ||
        sessionClash(session, block.session || 'all')) {
      return 'These dates are blocked on the owner calendar.';
    }
  }

  return null;
}

async function sendEmail(b, previousTotal, difference) {
  if (!process.env.RESEND_API_KEY) {
    return 'Email service is not configured.';
  }

  const differenceText = difference > 0
    ? `Additional amount to arrange: ${money(difference)}`
    : difference < 0
      ? `Potential refund or credit to arrange: ${money(-difference)}`
      : 'No change to the booking price.';

  const body = `Hello ${b.guest_name},

Your booking at Welham Nature Retreat has been updated.

Booking reference: ${b.request_reference}
Experience: ${TYPES[b.type]}
First date: ${dateString(b.start_date)}
Last date: ${dateString(b.end_date)}
Session: ${b.session || 'Accommodation'}
Guests: ${b.guests}

Previous booking total: ${money(previousTotal)}
Updated booking total: ${money(b.total_pence)}
${differenceText}

Any additional payment or refund will be arranged separately.
Your existing payment record has been preserved.

If anything is incorrect, please contact us.

Welham Nature Retreat
welhamlake@live.co.uk
07817175516`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>',
      to: [b.email],
      subject: `Your updated Welham booking - ${b.request_reference}`,
      text: body
    })
  });

  if (!response.ok) {
    console.error('Booking edit email error:', response.status);
    return 'The booking was saved, but the customer email could not be sent.';
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(login(String(req.query.reference || '')));
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  const reference = String(body.reference || '').trim();

  if (!passwordOK(body.password)) {
    return res.status(403).send(login(
      reference,
      '<p class="message error">Incorrect owner password.</p>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(login(
      reference,
      '<p class="message error">Database unavailable.</p>'
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

  let client;
  let transaction = false;

  try {
    client = await pool.connect();

    if (body.action === 'view') {
      const result = await client.query(
        `SELECT * FROM public.bookings WHERE request_reference=$1`,
        [reference]
      );
      const b = result.rows[0];

      if (!b) return res.status(404).send(login(
        reference, '<p class="message error">Booking not found.</p>'
      ));

      if (!['approved', 'confirmed', 'paid', 'pending'].includes(b.status)) {
        return res.status(400).send(login(
          reference, '<p class="message error">Cancelled or declined bookings cannot be edited.</p>'
        ));
      }

      return res.status(200).send(editForm(b));
    }

    if (body.action !== 'save') {
      return res.status(400).send(login(reference));
    }

    await client.query('BEGIN');
    transaction = true;
    await client.query('SELECT pg_advisory_xact_lock(918273645)');

    const result = await client.query(
      `SELECT * FROM public.bookings
       WHERE request_reference=$1 FOR UPDATE`,
      [reference]
    );

    const b = result.rows[0];
    if (!b) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(404).send(login(reference, 'Booking not found.'));
    }

    if (!ACTIVE.includes(b.status)) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(400).send(login(
        reference, 'This booking cannot be edited.'
      ));
    }

    const start = String(body.start_date || '');
    const end = String(body.end_date || '');
    const guests = Number(body.guests);
    const session = String(body.session || 'all');
    const name = String(body.guest_name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();

    const validation = checkRules(b.type, start, end, session, guests);

    if (validation ||
        !name || name.length > 150 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 254 ||
        phone.length > 50) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(400).send(editForm(
        b,
        `<p class="message error">${esc(validation || 'Please check the guest details.')}</p>`
      ));
    }

    const clash = await checkAvailability(client, b, start, end, session);

    if (clash) {
      await client.query('ROLLBACK');
      transaction = false;
      return res.status(409).send(editForm(
        b, `<p class="message error">${esc(clash)}</p>`
      ));
    }

    const previousTotal = Number(b.total_pence);
    const updatedTotal = calculate(b.type, start, end, guests);
    const difference = updatedTotal - previousTotal;

    const saved = await client.query(
      `UPDATE public.bookings
       SET start_date=$2, end_date=$3, session=$4,
           guests=$5, guest_name=$6, email=$7, phone=$8,
           total_pence=$9
       WHERE id=$1
       RETURNING *`,
      [b.id, start, end, session, guests,
       name, email, phone, updatedTotal]
    );

    await client.query('COMMIT');
    transaction = false;

    let emailError;
    try {
      emailError = await sendEmail(
        saved.rows[0], previousTotal, difference
      );
    } catch (e) {
      console.error('Edit notification error:', e.message);
      emailError = 'Booking saved, but the email could not be sent.';
    }

    const differenceMessage = difference > 0
      ? `Additional amount to collect manually: ${money(difference)}`
      : difference < 0
        ? `Potential refund or credit to arrange manually: ${money(-difference)}`
        : 'No change in booking price.';

    return res.status(200).send(page(`<div class="card">
<h2>Booking Updated</h2>
<p class="message">Changes saved successfully.</p>
<p><strong>Reference:</strong> ${esc(reference)}</p>
<p>Previous total: ${money(previousTotal)}</p>
<p>New total: ${money(updatedTotal)}</p>
<p><strong>${esc(differenceMessage)}</strong></p>
<p>Existing payment status: ${esc(saved.rows[0].payment_status)}</p>
<p class="message ${emailError ? 'error' : ''}">
${emailError ? esc(emailError) : 'Customer notification email accepted for sending.'}
</p>
<p><a href="/api/booking-edit?reference=${encodeURIComponent(reference)}">Edit again</a></p>
</div>`));

  } catch (e) {
    if (transaction && client) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('Booking edit error:', e.code || e.message);
    return res.status(500).send(login(
      reference,
      '<p class="message error">Unable to update booking. No confirmation has been issued.</p>'
    ));
  } finally {
    if (client) client.release();
    await pool.end();
  }
}
