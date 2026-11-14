
import pg from 'pg';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

const TYPES = {
  cabin: 'Luxury Cabin',
  cabin_hide: 'Luxury Cabin Wildlife Hide',
  hide: 'Woodland Wildlife Pond Hide',
  island: 'Island Glamping',
  island_hides: 'Island Wildlife Hides'
};

const SOURCES = ['Telephone', 'Facebook', 'Airbnb', 'Direct', 'Other'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

const BLOCK_NAMES = {
  cabin: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  cabin_hide: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  hide: ['hide', 'Separate Wildlife Hide', 'Woodland Wildlife Pond Hide'],
  island: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides'],
  island_hides: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides']
};

function esc(value) {
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

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(value, days) {
  const d = new Date(value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return '';
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function daysBetween(start, end) {
  return Math.round((
    new Date(end + 'T12:00:00Z') -
    new Date(start + 'T12:00:00Z')
  ) / 86400000);
}

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = key => parts.find(p => p.type === key)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function range(type, start, end) {
  if (type === 'hide') return { start, end: addDays(end || start, 1) };
  if (['cabin_hide', 'island_hides'].includes(type)) {
    return { start, end: addDays(start, 1) };
  }
  return { start, end: addDays(end, 1) };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function related(a, b) {
  return a === b ||
    (['cabin', 'cabin_hide'].includes(a) &&
     ['cabin', 'cabin_hide'].includes(b)) ||
    (['island', 'island_hides'].includes(a) &&
     ['island', 'island_hides'].includes(b));
}

function bookingConflict(request, existing) {
  if (!related(request.type, existing.type)) return false;

  const start = dateOnly(existing.start_date);
  const end = dateOnly(existing.end_date) || start;
  if (!overlaps(request.range, range(existing.type, start, end))) return false;

  if (request.type !== 'hide') return true;

  const session = existing.session || 'all';
  return session === 'all' ||
    request.session === 'all' ||
    session === request.session;
}

function blockConflict(request, block) {
  if (!BLOCK_NAMES[request.type].includes(block.experience)) return false;

  const blockRange = {
    start: dateOnly(block.start_date),
    end: addDays(dateOnly(block.end_date), 1)
  };
  if (!overlaps(request.range, blockRange)) return false;

  if (request.type !== 'hide') return true;
  return !block.session ||
    block.session === 'all' ||
    block.session === request.session;
}

function page(content) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Add Manual Booking - Welham Lake</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:20px}
header h1{font-size:22px;margin:0}
main{max-width:650px;margin:auto;padding:15px}
.panel{background:white;border-radius:12px;padding:20px;margin:12px 0}
label{display:block;font-weight:bold;margin-top:16px}
input,select,button{width:100%;font:inherit;padding:12px;border-radius:8px;margin-top:7px}
input,select{border:1px solid #aaa;background:white}
button,.action{background:#234735;color:white;border:0;font-weight:bold;cursor:pointer}
.action{display:inline-block;text-decoration:none;padding:12px;border-radius:8px}
.note{background:#e7f2e9;padding:12px;border-radius:8px}
.error{background:#fff0ed;color:#8b2626;padding:12px;border-radius:8px}
small{color:#627064}
</style></head><body>
<header><h1>Welham Lake Nature Retreat</h1>Manual Booking</header>
<main>${content}</main></body></html>`;
}

function form(message = '') {
  const options = Object.entries(TYPES)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`)
    .join('');

  const sources = SOURCES
    .map(value => `<option value="${esc(value)}">${esc(value)}</option>`)
    .join('');

  return page(`<div class="panel">
<h2>+ Add Booking</h2>
${message}
<form method="POST" action="/api/manual-booking">
<label>Owner Password</label>
<input type="password" name="password" required autocomplete="current-password">

<label>Guest Name</label>
<input name="guest_name" maxlength="120" required>

<label>Email (optional)</label>
<input type="email" name="email" maxlength="254">

<label>Phone (optional)</label>
<input name="phone" maxlength="60">

<label>Experience</label>
<select name="type" id="type" required>${options}</select>

<label>Number of Guests</label>
<select name="guests">
<option value="1">1 Person</option>
<option value="2" selected>2 People</option>
</select>

<label>Arrival / First Session Date</label>
<input type="date" name="start_date" required>

<label>Departure / Final Session Date</label>
<input type="date" name="end_date">

<label>Hide Session</label>
<select name="session" id="session">
<option value="day">Daytime</option>
<option value="night">Overnight</option>
</select>

<label>Booking Source</label>
<select name="source">${sources}</select>

<label>Booking Amount (£)</label>
<input type="number" name="amount" min="0" max="100000" step="0.01" required>

<label>Payment Status</label>
<select name="payment">
<option value="awaiting">Awaiting Payment</option>
<option value="paid">Paid</option>
</select>

<p class="note">Manual bookings reserve dates immediately and do not expire automatically. Check the guest's dates carefully before saving.</p>

<button type="submit">Save Manual Booking</button>
</form>
<p><small>For accommodation, enter the departure date. For a single woodland hide session, the final date may be left blank.</small></p>
</div>
<script>
const type = document.getElementById('type');
const session = document.getElementById('session');
function updateSession() {
  const hide = ['hide','cabin_hide','island_hides'].includes(type.value);
  session.disabled = !hide;
  if (type.value !== 'hide') session.value = 'day';
}
type.addEventListener('change', updateSession);
updateSession();
</script>`);
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

  if (req.method === 'GET') return res.status(200).send(form());
  if (req.method !== 'POST') {
    return res.status(405).send(page('Method not allowed'));
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(body.password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(form(
      '<p class="error">Incorrect owner password. Nothing saved.</p>'
    ));
  }

  const type = String(body.type || '');
  const name = String(body.guest_name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const start = String(body.start_date || '');
  const endInput = String(body.end_date || '');
  const sessionInput = String(body.session || '');
  const payment = String(body.payment || '');
  const source = String(body.source || '');
  const guests = Number(body.guests);
  const amount = String(body.amount || '');

  if (
    !Object.hasOwn(TYPES, type) ||
    !name || name.length > 120 ||
    (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) ||
    phone.length > 60 ||
    ![1, 2].includes(guests) ||
    !validDate(start) ||
    !SOURCES.includes(source) ||
    !['paid', 'awaiting'].includes(payment) ||
    !/^\d{1,6}(\.\d{1,2})?$/.test(amount)
  ) {
    return res.status(400).send(form(
      '<p class="error">Please check the booking details. Nothing saved.</p>'
    ));
  }

  if (start < ukToday()) {
    return res.status(400).send(form(
      '<p class="error">Please choose a current or future date.</p>'
    ));
  }

  if (['island', 'island_hides'].includes(type) && start < '2027-03-01') {
    return res.status(400).send(form(
      '<p class="error">Island experiences begin in March 2027.</p>'
    ));
  }

  const hide = ['hide', 'cabin_hide', 'island_hides'].includes(type);
  let end = endInput;
  let session = null;

  if (hide) {
    session = type === 'hide' ? sessionInput : 'day';

    if (type === 'hide') {
      if (!['day', 'night'].includes(session)) {
        return res.status(400).send(form(
          '<p class="error">Choose a valid hide session.</p>'
        ));
      }

      end = endInput || start;
      const sessions = validDate(end) ? daysBetween(start, end) + 1 : 0;
      if (sessions < 1 || sessions > 7) {
        return res.status(400).send(form(
          '<p class="error">Choose 1–7 consecutive hide sessions.</p>'
        ));
      }
    } else {
      end = '';
    }
  } else {
    if (!validDate(end) || daysBetween(start, end) < 2 ||
        daysBetween(start, end) > 60) {
      return res.status(400).send(form(
        '<p class="error">Accommodation requires 2–60 nights.</p>'
      ));
    }
  }

  const request = {
    type,
    session,
    range: range(type, start, end || start)
  };

  const totalPence = Math.round(Number(amount) * 100);
  const reference = 'WEL-M-' + randomBytes(6).toString('hex').toUpperCase();

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page('Database unavailable.'));
  }

  const pool = poolConnection();
  let client;
  let committed = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(918273645)');

    await client.query(`
      UPDATE public.bookings
      SET status='expired'
      WHERE status='pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);

    const blocks = await client.query(`
      SELECT experience, start_date, end_date, session
      FROM public.blocked_dates
      WHERE end_date >= $1::date
        AND start_date < $2::date
    `, [request.range.start, request.range.end]);

    if (blocks.rows.some(b => blockConflict(request, b))) {
      await client.query('ROLLBACK');
      return res.status(409).send(form(
        '<p class="error">These dates are blocked. Nothing saved.</p>'
      ));
    }

    const existing = await client.query(`
      SELECT type, start_date, end_date, session, status, expires_at
      FROM public.bookings
      WHERE status = ANY($1::text[])
        AND start_date < $2::date
        AND (end_date IS NULL OR end_date >= $3::date)
    `, [ACTIVE, request.range.end, addDays(request.range.start, -1)]);

    const conflict = existing.rows.some(b =>
      !(b.status === 'pending' && b.expires_at &&
        new Date(b.expires_at).getTime() <= Date.now()) &&
      bookingConflict(request, b)
    );

    if (conflict) {
      await client.query('ROLLBACK');
      return res.status(409).send(form(
        '<p class="error">These dates already have a booking. Nothing saved.</p>'
      ));
    }

    await client.query(`
      INSERT INTO public.bookings (
        type, start_date, end_date, session, guests,
        guest_name, email, phone, total_pence,
        deposit_pence, status, payment_status,
        approval_token_hash, request_reference, expires_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        0,'confirmed',$10,$11,$12,NULL
      )
    `, [
      type, start, end || null, session, guests,
      name, email || null, phone || null, totalPence,
      payment === 'paid' ? 'paid' : 'awaiting',
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      reference
    ]);

    await client.query('COMMIT');
    committed = true;

    return res.status(200).send(page(`
      <div class="panel">
        <h2>Booking Saved Successfully</h2>
        <p class="note">The dates have been reserved.</p>
        <p><strong>Reference:</strong> ${esc(reference)}</p>
        <p><strong>Guest:</strong> ${esc(name)}</p>
        <p><strong>Experience:</strong> ${esc(TYPES[type])}</p>
        <p><strong>Dates:</strong> ${esc(start)} to ${esc(end || start)}</p>
        <p><strong>Source:</strong> ${esc(source)}</p>
        <p><strong>Payment:</strong> ${esc(payment)}</p>
        <p><strong>Total:</strong> £${(totalPence / 100).toFixed(2)}</p>
        <p><a class="action" href="/api/manual-booking">Add Another Booking</a></p>
        <p><a href="/api/calendar">Return to Owner Calendar</a></p>
      </div>
    `));

  } catch (error) {
    if (client && !committed) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('Manual booking error:', error.code || error.message);
    return res.status(500).send(form(
      '<p class="error">Unable to save booking. No confirmation was received. Check the calendar before retrying.</p>'
    ));
  } finally {
    if (client) client.release();
    await pool.end();
  }
}
