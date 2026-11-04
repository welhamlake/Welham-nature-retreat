
import pg from 'pg';

const { Pool } = pg;
const TYPES = ['cabin', 'hide', 'island', 'island_hides'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];
const BLOCK_NAMES = {
  cabin: ['cabin', 'Luxury Cabin'],
  hide: ['hide', 'Separate Wildlife Hide'],
  island: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides'],
  island_hides: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides']
};

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function sendError(res, status, message) {
  return res.status(status).json({ available: false, error: message });
}

function unavailable(res) {
  return res.status(200).json({
    available: false, message: 'These dates are unavailable.'
  });
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function bookingRange(type, start, end) {
  if (type === 'hide' || type === 'island_hides') return [start, addDays(start, 1)];
  if (!end) return null;
  return [start, type === 'island' ? addDays(end, 1) : end];
}

function bookingConflict(request, existing) {
  const islandRequest = ['island', 'island_hides'].includes(request.type);
  const islandExisting = ['island', 'island_hides'].includes(existing.type);

  if (islandRequest && islandExisting) {
    const a = bookingRange(request.type, request.start, request.end);
    const b = bookingRange(existing.type, existing.start, existing.end);
    return !!b && overlaps(a[0], a[1], b[0], b[1]);
  }

  if (request.type !== existing.type) return false;

  if (request.type === 'hide') {
    return request.start === existing.start && (
      !existing.session || existing.session === 'all' ||
      request.session === existing.session
    );
  }

  const a = bookingRange(request.type, request.start, request.end);
  const b = bookingRange(existing.type, existing.start, existing.end);
  return !!b && overlaps(a[0], a[1], b[0], b[1]);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed');

  const { type, start_date, end_date, session } = req.query || {};
  if (!TYPES.includes(type) || !validDate(start_date)) {
    return sendError(res, 400, 'Please choose a valid experience and date.');
  }

  const today = ukToday();
  if (start_date < today) {
    return sendError(res, 400, 'Please choose a current or future date.');
  }
  if (['island', 'island_hides'].includes(type) && start_date < '2027-03-01') {
    return sendError(res, 400, 'Island bookings start from March 2027.');
  }
  if (type === 'island_hides' && start_date > addDays(today, 14)) {
    return sendError(res, 400, 'Island hides can only be booked up to 14 days ahead.');
  }

  const isHide = ['hide', 'island_hides'].includes(type);
  let departure = null;
  let hideSession = null;

  if (isHide) {
    if ((type === 'island_hides' && session !== 'day') ||
        (type === 'hide' && !['day', 'night'].includes(session))) {
      return sendError(res, 400, 'Please select a valid hide session.');
    }
    hideSession = session;
  } else {
    if (!validDate(end_date)) {
      return sendError(res, 400, 'Please select a departure date.');
    }
    const nights = Math.round((
      new Date(end_date + 'T12:00:00Z') - new Date(start_date + 'T12:00:00Z')
    ) / 86400000);
    if (nights < 2 || nights > 60) {
      return sendError(res, 400, 'Accommodation requires between 2 and 60 nights.');
    }
    if (type === 'cabin') {
      const day = new Date(start_date + 'T12:00:00Z').getUTCDay();
      if (day === 0 || day === 6) {
        return sendError(res, 400, 'Cabin arrivals are Monday to Friday.');
      }
    }
    departure = end_date;
  }

  if (!process.env.DATABASE_URL) {
    return sendError(res, 503, 'Availability service is not configured.');
  }

  const request = { type, start: start_date, end: departure, session: hideSession };
  const range = bookingRange(type, start_date, departure);
  const relatedTypes = ['island', 'island_hides'].includes(type)
    ? ['island', 'island_hides'] : [type];

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.SUPABASE_CA_CERT ? { ca: process.env.SUPABASE_CA_CERT } : {})
    },
    connectionTimeoutMillis: 5000,
    max: 1
  });

  try {
    // Accept both legacy short codes and the display names used by the owner block form.
    const blocks = await pool.query(
      `SELECT experience, start_date::text AS start_date,
              end_date::text AS end_date, session
       FROM public.blocked_dates
       WHERE experience = ANY($1::text[])`,
      [BLOCK_NAMES[type]]
    );

    for (const block of blocks.rows) {
      const blockEnd = addDays(block.end_date, 1);
      if (!overlaps(range[0], range[1], block.start_date, blockEnd)) continue;
      if (['island', 'island_hides'].includes(type) || !isHide ||
          !block.session || block.session === 'all' ||
          block.session === hideSession) {
        return unavailable(res);
      }
    }

    const bookings = await pool.query(
      `SELECT type, start_date::text AS start_date,
              end_date::text AS end_date, session, status, expires_at
       FROM public.bookings
       WHERE type = ANY($1::text[])
         AND status = ANY($2::text[])`,
      [relatedTypes, ACTIVE]
    );

    const now = Date.now();
    for (const booking of bookings.rows) {
      if (booking.status === 'pending' && booking.expires_at &&
          new Date(booking.expires_at).getTime() <= now) continue;

      const existing = {
        type: booking.type, start: booking.start_date,
        end: booking.end_date, session: booking.session
      };
      if (bookingConflict(request, existing)) return unavailable(res);
    }

    return res.status(200).json({
      available: true, message: 'These dates are available to request.'
    });
  } catch (err) {
    console.error('Availability check failed:', err.code || err.message);
    return sendError(res, 500, 'Unable to check availability. Please try again.');
  } finally {
    await pool.end();
  }
}
