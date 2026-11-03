
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

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function page(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Booking Calendar</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:15px Arial,sans-serif}
header{background:#234735;color:white;padding:20px}
header h1{margin:0;font-size:23px}
main{max-width:1000px;margin:auto;padding:12px}
.panel{background:white;border-radius:12px;padding:15px;margin:12px 0}
input,button,select{font:inherit;padding:12px;border-radius:8px}
input{width:100%;border:1px solid #aaa;margin:10px 0}
button{background:#234735;color:white;border:0;font-weight:bold}
.login button{width:100%}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.toolbar button{padding:10px}
#monthTitle{font-size:19px;text-align:center}
.filters{display:flex;flex-wrap:wrap;gap:7px}
.filters button{background:#e5eae4;color:#234735}
.filters button.active{background:#234735;color:white}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;font-size:13px}
.dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:4px}
.green{background:#3e9a60}.amber{background:#e5a332}
.blue{background:#4189cc}.grey{background:#c9d0c9}
.weekdays,.calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.weekdays{text-align:center;font-weight:bold;font-size:12px}
.weekdays div{padding:9px 0}
.day{min-height:77px;border:1px solid #e4e8e2;background:white;
padding:5px 3px;overflow:hidden}
.day.empty{background:#f3f5f1}
.day.today{outline:2px solid #234735;outline-offset:-2px}
.daynum{font-weight:bold;font-size:13px;margin-bottom:5px}
.event{display:block;border-radius:4px;padding:4px 3px;margin:3px 0;
font-size:10px;overflow-wrap:anywhere;color:#142b1d}
.event.paid{background:#bce7c8}
.event.pending{background:#ffe1a0}
.event.awaiting{background:#c5dffc}
.event.other{background:#dce1dc}
.details{margin-top:12px}
.booking{padding:12px;border:1px solid #ddd;border-radius:8px;margin:8px 0}
small{color:#627064}
@media(min-width:650px){
.day{min-height:110px;padding:7px}
.event{font-size:12px}
}
</style>
</head>
<body>
<header><h1>Welham Nature Retreat</h1>Owner Booking Calendar</header>
<main>${content}</main>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(page(`
      <div class="panel login">
        <h2>Calendar Login</h2>
        <form method="POST" action="/api/calendar">
          <label for="password">Owner password</label>
          <input id="password" name="password" type="password" required>
          <button type="submit">Open Calendar</button>
        </form>
      </div>`));
  }

  if (req.method !== 'POST') {
    return res.status(405).send(page('Method not allowed'));
  }

  const password = typeof req.body === 'string'
    ? new URLSearchParams(req.body).get('password')
    : req.body?.password;

  if (!passwordMatches(password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(page(
      '<div class="panel">Incorrect password. <a href="/api/calendar">Try again</a></div>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page('Database unavailable'));
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
      WHERE start_date >= CURRENT_DATE - INTERVAL '2 years'
        AND start_date < CURRENT_DATE + INTERVAL '3 years'
      ORDER BY start_date ASC
      LIMIT 2000
    `);

    const bookings = result.rows.map(b => ({
      reference: b.request_reference,
      guest: b.guest_name,
      type: b.type,
      start: dateOnly(b.start_date),
      end: dateOnly(b.end_date) || dateOnly(b.start_date),
      session: b.session || '',
      status: b.status,
      payment: b.payment_status,
      total: (Number(b.total_pence) / 100).toFixed(2)
    }));

    const safeJson = JSON.stringify(bookings)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

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
          <span><i class="dot grey"></i>Other</span>
        </div>
      </div>
      <div class="panel">
        <div class="filters" id="filters"></div>
      </div>
      <div class="panel">
        <div class="weekdays">
          <div>Mon</div><div>Tue</div><div>Wed</div>
          <div>Thu</div><div>Fri</div><div>Sat</div><div>Sun</div>
        </div>
        <div class="calendar" id="calendar"></div>
        <div class="details" id="details"></div>
      </div>
      <p><small>Owner-only view. Cancelled and declined bookings are excluded from active calendar dates.</small></p>
      <script id="bookingData" type="application/json">${safeJson}</script>
      <script>
      (() => {
        const bookings = JSON.parse(
          document.getElementById('bookingData').textContent
        );
        const calendar = document.getElementById('calendar');
        const details = document.getElementById('details');
        const filters = document.getElementById('filters');
        const title = document.getElementById('monthTitle');
        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth();
        let selectedFilter = 'All';

        function escapeText(value) {
          return String(value ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;'
          })[c]);
        }

        function active(b) {
          return !['declined','cancelled','expired'].includes(
            String(b.status).toLowerCase()
          );
        }

        function colour(b) {
          if (b.payment === 'paid') return 'paid';
          if (b.status === 'pending') return 'pending';
          if (b.status === 'approved') return 'awaiting';
          return 'other';
        }

        function visible(b) {
          return active(b) &&
            (selectedFilter === 'All' || b.type === selectedFilter);
        }

        function matchesDate(b, date) {
          return visible(b) && date >= b.start && date <= b.end;
        }

        function showDetails(date) {
          const items = bookings.filter(b => matchesDate(b, date));
          details.replaceChildren();
          const heading = document.createElement('h3');
          heading.textContent = new Date(date + 'T12:00:00')
            .toLocaleDateString('en-GB', {
              weekday:'long', day:'numeric', month:'long', year:'numeric'
            });
          details.appendChild(heading);
          if (!items.length) {
            const p = document.createElement('p');
            p.textContent = 'No bookings recorded for this date.';
            details.appendChild(p);
            return;
          }
          items.forEach(b => {
            const div = document.createElement('div');
            div.className = 'booking';
            div.innerHTML =
              '<strong>' + escapeText(b.type) + '</strong>' +
              '<p>Guest: ' + escapeText(b.guest) + '</p>' +
              '<p>Reference: ' + escapeText(b.reference) + '</p>' +
              '<p>Dates: ' + escapeText(b.start) + ' to ' +
                 escapeText(b.end) + '</p>' +
              '<p>Session: ' + escapeText(b.session || '—') + '</p>' +
              '<p>Status: ' + escapeText(b.status) + '</p>' +
              '<p>Payment: ' + escapeText(b.payment) + '</p>' +
              '<p>Total: £' + escapeText(b.total) + '</p>';
            details.appendChild(div);
          });
        }

        const types = ['All', ...new Set(bookings.map(b => b.type).filter(Boolean))];
        types.forEach(type => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = type === 'All' ? 'All Experiences' : type;
          button.addEventListener('click', () => {
            selectedFilter = type;
            render();
          });
          filters.appendChild(button);
        });

        function render() {
          [...filters.children].forEach(button => {
            const type = button.textContent === 'All Experiences'
              ? 'All' : button.textContent;
            button.classList.toggle('active', type === selectedFilter);
          });

          title.textContent = new Date(year, month, 1)
            .toLocaleDateString('en-GB', {month:'long',year:'numeric'});

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
            if (date === [
              now.getFullYear(),
              String(now.getMonth() + 1).padStart(2, '0'),
              String(now.getDate()).padStart(2, '0')
            ].join('-')) cell.classList.add('today');

            const number = document.createElement('div');
            number.className = 'daynum';
            number.textContent = day;
            cell.appendChild(number);

            const items = bookings.filter(b => matchesDate(b, date));
            items.forEach(b => {
              const event = document.createElement('span');
              event.className = 'event ' + colour(b);
              event.textContent = b.type + (b.session ? ' ' + b.session : '');
              cell.appendChild(event);
            });

            cell.addEventListener('click', () => showDetails(date));
            calendar.appendChild(cell);
          }
        }

        document.getElementById('prev').addEventListener('click', () => {
          month--;
          if (month < 0) { month = 11; year--; }
          render();
        });

        document.getElementById('next').addEventListener('click', () => {
          month++;
          if (month > 11) { month = 0; year++; }
          render();
        });

        render();
      })();
      </script>
    `));
  } catch (error) {
    console.error('Calendar error:', error.code || error.message);
    return res.status(500).send(page(
      '<div class="panel">Unable to load calendar.</div>'
    ));
  } finally {
    await pool.end();
  }
}
