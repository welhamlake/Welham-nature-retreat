
import pg from 'pg';

const { Pool } = pg;

const TYPES = ['cabin', 'cabin_hide', 'hide', 'island', 'island_hides'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

const GROUPS = {
  cabin: ['cabin', 'cabin_hide'],
  cabin_hide: ['cabin', 'cabin_hide'],
  hide: ['hide'],
  island: ['island', 'island_hides'],
  island_hides: ['island', 'island_hides']
};

const BLOCKS = {
  cabin: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  cabin_hide: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  hide: ['hide', 'Separate Wildlife Hide', 'Woodland Wildlife Pool Hide'],
  island: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides'],
  island_hides: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides']
};

function addDays(value, days) {
  const date = new Date(value + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const part = key => parts.find(p => p.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function overlaps(a, b, c, d) {
  return a < d && c < b;
}

function bookingRange(type, start, end) {
  if (type === 'hide') return [start, addDays(end || start, 1)];
  if (type === 'cabin_hide' || type === 'island_hides') {
    return [start, addDays(start, 1)];
  }
  if (!end) return null;
  return [start, addDays(end, 1)];
}

function conflicts(request, booking) {
  if (!GROUPS[request.type].includes(booking.type)) return false;

  const a = bookingRange(request.type, request.start, request.end);
  const b = bookingRange(booking.type, booking.start, booking.end);
  if (!a || !b || !overlaps(a[0], a[1], b[0], b[1])) return false;

  if (request.type === 'hide' && booking.type === 'hide') {
    return !booking.session || booking.session === 'all' ||
      !request.session || request.session === 'all' ||
      booking.session === request.session;
  }

  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, month, session } = req.query || {};

  if (!TYPES.includes(type) ||
      typeof month !== 'string' ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ error: 'Invalid experience or month' });
  }

  const isHide = ['hide', 'cabin_hide', 'island_hides'].includes(type);
  if (isHide &&
      (type === 'hide' ? !['day', 'night'].includes(session) : session !== 'day')) {
    return res.status(400).json({ error: 'Invalid session' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Availability unavailable' });
  }

  const today = ukToday();
  const first = month + '-01';
  const last = addDays(addDays(first, 32).slice(0, 7) + '-01', -1);
  const next = addDays(last, 1);

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
    const [blockResult, bookingResult] = await Promise.all([
      pool.query(
        `SELECT experience, start_date::text AS start_date,
                end_date::text AS end_date, session
         FROM public.blocked_dates
         WHERE experience = ANY($1::text[])
           AND start_date < $2::date
           AND end_date >= $3::date`,
        [BLOCKS[type], next, first]
      ),
      pool.query(
        `SELECT type, start_date::text AS start_date,
                end_date::text AS end_date, session,
                status, expires_at
         FROM public.bookings
         WHERE type = ANY($1::text[])
           AND status = ANY($2::text[])
           AND start_date < $3::date
           AND end_date >= ($4::date - INTERVAL '1 day')`,
        [GROUPS[type], ACTIVE, next, first]
      )
    ]);

    const days = {};
    const now = Date.now();

    for (let date = first; date < next; date = addDays(date, 1)) {
      let available = date >= today;

      if (['island', 'island_hides'].includes(type) &&
          date < '2027-03-01') available = false;

      if (['cabin_hide', 'island_hides'].includes(type) &&
          date > addDays(today, 14)) available = false;

      if (type === 'cabin') {
        const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
        if (weekday === 0 || weekday === 6) available = false;
      }

      const request = {
        type,
        start: date,
        end: isHide ? date : addDays(date, 2),
        session: isHide ? session : null
      };

      const range = bookingRange(request.type, request.start, request.end);

      if (available) {
        available = !blockResult.rows.some(block => {
          if (!overlaps(
            range[0], range[1],
            block.start_date, addDays(block.end_date, 1)
          )) return false;

          if (type !== 'hide') return true;

          return !block.session || block.session === 'all' ||
            block.session === session;
        });
      }

      if (available) {
        available = !bookingResult.rows.some(booking => {
          if (booking.status === 'pending' &&
              booking.expires_at &&
              new Date(booking.expires_at).getTime() <= now) return false;

          return conflicts(request, {
            type: booking.type,
            start: booking.start_date,
            end: booking.end_date,
            session: booking.session
          });
        });
      }

      days[date] = available;
    }

    return res.status(200).json({
      type,
      month,
      session: isHide ? session : null,
      days
    });
  } catch (error) {
    console.error('Public calendar failed:', error.code || error.message);
    return res.status(500).json({ error: 'Unable to load availability' });
  } finally {
    await pool.end();
  }
}
