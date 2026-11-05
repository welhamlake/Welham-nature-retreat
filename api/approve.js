
import pg from 'pg';
import { createHash } from 'node:crypto';

const { Pool } = pg;

const experienceNames = {
  cabin: 'Luxury Cabin',
  cabin_hide: 'Luxury Cabin Wildlife Hide',
  island: 'Island Glamping',
  hide: 'Separate Wildlife Hide',
  island_hides: 'Island Wildlife Hides'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function formatDate(value) {
  if (!value) return 'Not applicable';

  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
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

  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return res.status(400).send('Invalid approval link.');
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send('Database unavailable.');
  }

  const hash = createHash('sha256')
    .update(token)
    .digest('hex');

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

    const experience =
      experienceNames[b.type] || b.type;

    const isHide = [
      'hide',
      'island_hides',
      'cabin_hide'
    ].includes(b.type);

    const total = (
      Number(b.total_pence) / 100
    ).toFixed(2);

    const dateLabel = isHide
      ? 'Session date'
      : 'Arrival';

    const endLabel = isHide
      ? ''
      : `<p><strong>Departure:</strong>
           ${escapeHtml(formatDate(b.end_date))}</p>`;

    const sessionNames = {
      day: 'Daytime (07:00–17:00)',
      night: 'Overnight (18:00–06:00)'
    };

    const session =
      sessionNames[b.session] ||
      b.session ||
      'Not applicable';

    const pending = b.status === 'pending';

    const actions = pending ? `
      <hr>
      <p>Review this booking and choose an action:</p>

      <form method="POST" action="/api/booking-decision">
        <input
          type="hidden"
          name="token"
          value="${escapeHtml(token)}"
        >

        <button
          class="approve"
          type="submit"
          name="decision"
          value="approve"
        >
          Approve booking
        </button>

        <button
          class="decline"
          type="submit"
          name="decision"
          value="decline"
        >
          Decline booking
        </button>
      </form>

      <p class="note">
        Approving a booking sends the guest their
        bank transfer payment instructions.
        The booking is not confirmed until
        payment has been verified.
      </p>
    ` : `
      <p class="note">
        This booking has already been processed.
        Current status: ${escapeHtml(b.status)}.
      </p>
    `;

    const page = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Booking Approval</title>
<style>
* { box-sizing: border-box; }

body {
  margin: 0;
  background: #f3f5f1;
  color: #243328;
  font: 16px Arial, sans-serif;
  padding: 18px;
}

main {
  max-width: 520px;
  margin: 25px auto;
  background: white;
  padding: 24px;
  border-radius: 12px;
}

h1 {
  font-size: 25px;
  color: #234735;
}

h2 {
  font-size: 21px;
}

p {
  line-height: 1.6;
  overflow-wrap: anywhere;
}

button {
  display: block;
  width: 100%;
  padding: 15px;
  margin: 12px 0;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-weight: bold;
  color: white;
  cursor: pointer;
}

.approve {
  background: #234735;
}

.decline {
  background: #a13b35;
}

.note {
  background: #eef3ed;
  padding: 14px;
  border-radius: 8px;
  font-size: 14px;
}

hr {
  border: 0;
  border-top: 1px solid #ddd;
  margin: 22px 0;
}
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
    ${escapeHtml(experience)}</p>

  <p><strong>${dateLabel}:</strong>
    ${escapeHtml(formatDate(b.start_date))}</p>

  ${endLabel}

  <p><strong>Session:</strong>
    ${escapeHtml(session)}</p>

  <p><strong>Guests:</strong>
    ${escapeHtml(b.guests)}</p>

  <p><strong>Total:</strong> £${total}</p>

  <p><strong>Status:</strong>
    ${escapeHtml(b.status)}</p>

  ${actions}
</main>
</body>
</html>`;

    return res.status(200).send(page);

  } catch (error) {
    console.error(
      'Approval page error:',
      error.code || error.message
    );

    return res.status(500).send(
      'Unable to load booking.'
    );

  } finally {
    await pool.end();
  }
}
