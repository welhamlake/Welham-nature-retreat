
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

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

function isoDate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
    '\u2028': '\\u2028', '\u2029': '\\u2029'
  })[c]);
}

function layout(content) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Welham Booking Dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:22px 16px}
main{max-width:900px;margin:auto;padding:18px}
h1{font-size:23px;margin:0}
h2{font-size:20px}
.card{background:white;border-radius:12px;padding:17px;margin:14px 0;box-shadow:0 2px 8px #0001}
input,button{font:inherit;padding:13px;border-radius:8px;width:100%;margin:8px 0}
input{border:1px solid #bbb}
button,.action{display:block;background:#234735;color:white;border:0;border-radius:8px;padding:13px;text-align:center;text-decoration:none;font-weight:bold;margin:8px 0}
button.decline{background:#8b3f35}
small{color:#66736a}
.status{font-weight:bold}
.calendar-controls{display:flex;align-items:center;gap:10px;justify-content:space-between}
.calendar-controls button{width:auto;min-width:48px;margin:0}
.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;margin-top:14px}
.calendar-grid .weekday{text-align:center;font-size:12px;font-weight:bold;color:#52645a;padding:8px 0}
.calendar-day{min-height:63px;border:1px solid #d9dfd9;border-radius:7px;background:#fafbf9;padding:5px 3px;overflow:hidden;text-align:left}
.calendar-day .day-number{font-size:13px;font-weight:bold}
.calendar-day .dots{display:flex;gap:3px;flex-wrap:wrap;margin-top:7px}
.calendar-day .dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.calendar-day.has-items{border-color:#648975;cursor:pointer}
.calendar-day.chosen{outline:3px solid #c7a15d}
.dot.pending,.legend .pending{background:#c28b2f}
.dot.approved,.legend .approved{background:#4677b8}
.dot.confirmed,.dot.paid,.legend .confirmed{background:#267348}
.dot.blocked,.legend .blocked{background:#9b4d4d}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0;font-size:13px}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:10px;height:10px;border-radius:50%;display:inline-block}
#calendarDetails{margin-top:15px}
#calendarDetails .entry{border-top:1px solid #e0e4df;padding:10px 0;overflow-wrap:anywhere}
.calendar-note{font-size:13px;color:#59685e}
@media(max-width:450px){.calendar-day{min-height:54px}.calendar-grid{gap:3px}.card{padding:13px}}
</style>
</head>
<body>
<header><h1>Welham Nature Retreat</h1><div>Booking Management</div></header>
<main>${content}</main>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method === 'GET') {
    return res.status(200).send(layout(`
      <div class="card">
        <h2>Owner Login</h2>
        <form method="POST" action="/api/dashboard">
          <label for="password">Owner password</label>
          <input id="password" name="password" type="password"
                 autocomplete="current-password" required>
          <button type="submit">View Bookings</button>
        </form>
      </div>`));
  }

  if (req.method !== 'POST') {
    return res.status(405).send(layout('Method not allowed'));
  }

  const password = typeof req.body === 'string'
    ? new URLSearchParams(req.body).get('password')
    : req.body?.password;

  if (!passwordMatches(password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(layout(
      '<div class="card"><h2>Access denied</h2><p>Incorrect password.</p><a href="/api/dashboard">Try again</a></div>'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(layout('Database unavailable'));
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
      ORDER BY start_date DESC
      LIMIT 100
    `);

    const calendarBookings = await pool.query(`
      SELECT request_reference, guest_name, type, start_date, end_date,
             session, status, payment_status, total_pence, expires_at, payment_due_at
      FROM public.bookings
      WHERE start_date <= (CURRENT_DATE + INTERVAL '18 months')
        AND COALESCE(end_date, start_date) >= (CURRENT_DATE - INTERVAL '3 months')
      ORDER BY start_date ASC
      LIMIT 3000
    `);
    const blockedDates = await pool.query(`
      SELECT experience, start_date, end_date, session
      FROM public.blocked_dates
      WHERE start_date <= (CURRENT_DATE + INTERVAL '18 months')
        AND end_date >= (CURRENT_DATE - INTERVAL '3 months')
      ORDER BY start_date ASC
      LIMIT 3000
    `);

    const calendarData = {
      bookings: calendarBookings.rows.map(b => ({
        reference: String(b.request_reference ?? ''),
        guest: String(b.guest_name ?? ''),
        type: String(b.type ?? ''),
        start: isoDate(b.start_date),
        end: isoDate(b.end_date) || isoDate(b.start_date),
        session: String(b.session ?? ''),
        status: String(b.status ?? ''),
        payment: String(b.payment_status ?? ''),
        total: Number(b.total_pence || 0) / 100,
        expiresAt: b.expires_at ? new Date(b.expires_at).toISOString() : '',
        paymentDueAt: b.payment_due_at ? new Date(b.payment_due_at).toISOString() : ''
      })),
      blocks: blockedDates.rows.map(b => ({
        type: String(b.experience ?? ''),
        start: isoDate(b.start_date),
        end: isoDate(b.end_date),
        session: String(b.session ?? '')
      }))
    };

    const cards = result.rows.map(b => {
      const ref = escapeHtml(b.request_reference);
      let actions = '';

      if (b.status === 'pending') {
        actions = `
          <form method="POST" action="/api/dashboard-confirm">
            <input type="hidden" name="reference" value="${ref}">
            <button type="submit" name="decision" value="approve">
              Approve booking
            </button>
            <button class="decline" type="submit"
                    name="decision" value="decline">
              Decline booking
            </button>
          </form>`;
      }

      if (b.status === 'approved' && b.payment_status === 'unpaid') {
        actions = `
          <a class="action" href="/api/payment-admin">
            Mark as Paid
          </a>`;
      }

      return `
        <div class="card">
          <h2>${escapeHtml(b.guest_name)}</h2>
          <p><strong>Reference:</strong> ${ref}</p>
          <p><strong>Experience:</strong> ${escapeHtml(b.type)}</p>
          <p><strong>Start:</strong> ${formatDate(b.start_date)}</p>
          ${b.end_date ? `<p><strong>End:</strong> ${formatDate(b.end_date)}</p>` : ''}
          ${b.session ? `<p><strong>Session:</strong> ${escapeHtml(b.session)}</p>` : ''}
          <p class="status">Booking: ${escapeHtml(b.status)}</p>
          <p class="status">Payment: ${escapeHtml(b.payment_status)}</p>
          <p><strong>Total:</strong> £${(Number(b.total_pence) / 100).toFixed(2)}</p>
          ${actions}
        </div>`;
    }).join('');

    return res.status(200).send(layout(`
      <section class="card">
        <h2>Private Booking Calendar</h2>
        <p class="calendar-note">Tap a date to see bookings, their status and manually blocked dates. Accommodation checkout days are included. Only you can see guest details after logging in.</p>
        <div class="calendar-controls">
          <button type="button" id="calPrev" aria-label="Previous month">❮</button>
          <strong id="calTitle" aria-live="polite"></strong>
          <button type="button" id="calNext" aria-label="Next month">❯</button>
        </div>
        <div class="legend">
          <span><i class="pending"></i>Pending</span>
          <span><i class="approved"></i>Approved</span>
          <span><i class="confirmed"></i>Paid / confirmed</span>
          <span><i class="blocked"></i>Blocked</span>
        </div>
        <div class="calendar-grid" id="calGrid" aria-label="Booking calendar"></div>
        <div id="calendarDetails" aria-live="polite"><small>Choose a date to view details.</small></div>
        <p class="calendar-note">Expired, cancelled and declined requests are not shown as occupied. Dates and sessions remain subject to the booking system's availability rules.</p>
      </section>
      <script id="calendarData" type="application/json">${safeJson(calendarData)}</script>
      <script>
      (() => {
        const data = JSON.parse(document.getElementById('calendarData').textContent);
        const grid = document.getElementById('calGrid');
        const title = document.getElementById('calTitle');
        const details = document.getElementById('calendarDetails');
        const dateParts = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
        const value = key => Number(dateParts.find(p=>p.type===key).value);
        const todayParts = [value('year'),value('month'),value('day')];
        let year = todayParts[0], month = todayParts[1] - 1, selected = '';
        const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const active = new Set(['pending','approved','confirmed','paid']);
        const typeNames = {cabin:'Luxury Cabin',cabin_hide:'Cabin Wildlife Hide',hide:'Separate Wildlife Hide',island:'Island Glamping',island_hides:'Island Wildlife Hides'};
        function addDays(date, days) {
          const d = new Date(date+'T12:00:00Z');
          d.setUTCDate(d.getUTCDate()+days);
          return d.toISOString().slice(0,10);
        }
        function occupied(b, date) {
          if (!active.has(b.status)) return false;
          if (b.status==='pending' && b.expiresAt && Date.parse(b.expiresAt)<=Date.now()) return false;
          if (b.status==='approved' && b.payment!=='paid' && b.paymentDueAt && Date.parse(b.paymentDueAt)<=Date.now()) return false;
          return date>=b.start && date<=b.end;
        }
        function onDate(date) {
          const bookings=data.bookings.filter(b=>occupied(b,date));
          const blocks=data.blocks.filter(b=>date>=b.start&&date<=b.end);
          return {bookings,blocks};
        }
        function el(tag,cls,txt) {
          const node=document.createElement(tag);
          if(cls) node.className=cls;
          if(txt!==undefined) node.textContent=txt;
          return node;
        }
        function showDetails(date) {
          selected=date;
          details.replaceChildren();
          const heading=el('h3','',new Date(date+'T12:00:00Z').toLocaleDateString('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long',year:'numeric'}));
          details.appendChild(heading);
          const {bookings,blocks}=onDate(date);
          if(!bookings.length&&!blocks.length) details.appendChild(el('p','', 'No active bookings or blocked dates recorded.'));
          bookings.forEach(b=>{
            const item=el('div','entry');
            item.appendChild(el('strong','',(typeNames[b.type]||b.type)+' — '+b.guest));
            item.appendChild(el('div','',b.start+' to '+b.end+(b.session?' · '+b.session:'')));
            item.appendChild(el('div','', 'Reference: '+b.reference+' · '+b.status+' · Payment: '+b.payment+' · £'+b.total.toFixed(2)));
            if(b.type==='cabin'||b.type==='island') item.appendChild(el('small','',date===b.end?'Checkout / preparation day':'Accommodation stay (hide included)'));
            details.appendChild(item);
          });
          blocks.forEach(b=>{
            const item=el('div','entry');
            item.appendChild(el('strong','', 'Blocked: '+(typeNames[b.type]||b.type)));
            item.appendChild(el('div','',b.start+' to '+b.end+(b.session?' · '+b.session:'')));
            details.appendChild(item);
          });
          render();
        }
        function render() {
          title.textContent=monthNames[month]+' '+year;
          grid.replaceChildren();
          ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(w=>grid.appendChild(el('div','weekday',w)));
          const first=(new Date(Date.UTC(year,month,1)).getUTCDay()+6)%7;
          for(let i=0;i<first;i++) grid.appendChild(el('div',''));
          const days=new Date(Date.UTC(year,month+1,0)).getUTCDate();
          for(let day=1;day<=days;day++) {
            const date=year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
            const {bookings,blocks}=onDate(date);
            const button=el('button','calendar-day'+(bookings.length||blocks.length?' has-items':'')+(selected===date?' chosen':''));
            button.type='button'; button.setAttribute('aria-label',date+': '+bookings.length+' bookings, '+blocks.length+' blocks');
            button.appendChild(el('span','day-number',String(day)));
            const dots=el('span','dots');
            const kinds=new Set(bookings.map(b=>b.status==='paid'||b.status==='confirmed'?'confirmed':b.status));
            if(blocks.length) kinds.add('blocked');
            kinds.forEach(kind=>dots.appendChild(el('i','dot '+kind)));
            button.appendChild(dots);
            button.addEventListener('click',()=>showDetails(date));
            grid.appendChild(button);
          }
        }
        function changeMonth(delta) {
          const d=new Date(Date.UTC(year,month+delta,1));
          year=d.getUTCFullYear();month=d.getUTCMonth();selected='';
          details.replaceChildren(el('small','','Choose a date to view details.'));
          render();
        }
        document.getElementById('calPrev').addEventListener('click',()=>changeMonth(-1));
        document.getElementById('calNext').addEventListener('click',()=>changeMonth(1));
        render();
      })();
      </script>
      <h2>Your Bookings (${result.rows.length})</h2>
      <small>Showing up to 100 bookings, newest dates first.</small>
      ${cards || '<div class="card">No bookings found.</div>'}
      <p><a href="/api/dashboard">Return to login</a></p>
    `));
  } catch (error) {
    console.error('Dashboard error:', error.code || error.message);
    return res.status(500).send(layout(
      '<div class="card">Unable to load bookings.</div>'
    ));
  } finally {
    await pool.end();
  }
}
