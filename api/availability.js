
import pg from 'pg';

const { Pool } = pg;

const TYPES = ['cabin', 'hide', 'island', 'island_hides'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) return false;

  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ukToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const get = type =>
    parts.find(part => part.type === type)?.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  const { type, start_date, end_date, session } = req.query;

  if (!TYPES.includes(type) || !validDate(start_date)) {
    return res.status(400).json({
      error: 'Please select a valid experience and date.'
    });
  }

  const today = ukToday();

  if (start_date < today) {
    return res.status(400).json({
      error: 'Please choose a current or future date.'
    });
  }

  if (
    ['island', 'island_hides'].includes(type) &&
    start_date < '2027-03-01'
  ) {
    return res.status(200).json({
      available: false,
      message: 'Island bookings start from 1 March 2027.'
    });
  }

  if (
    type === 'island_hides' &&
    start_date > addDays(today, 14)
  ) {
    return res.status(200).json({
      available: false,
      message: 'Island hides can only be booked 14 days ahead.'
    });
  }

  const isHide = type === 'hide' || type === 'island_hides';

  let rangeEnd;
  let selectedSession = null;

  if (isHide) {
    if (
      (type === 'hide' && !['day', 'night'].includes(session)) ||
      (type === 'island_hides' && session !== 'day')
    ) {
      return res.status(400).json({
        error: 'Please select a valid hide session.'
      });
    }

    selectedSession = session;
    rangeEnd = addDays(start_date, 1);
  } else {
    if (!validDate(end_date)) {
      return res.status(400).json({
        error: 'Please select a departure date.'
      });
    }

    const nights = Math.round(
      (
        new Date(end_date + 'T12:00:00Z') -
        new Date(start_date + 'T12:00:00Z')
      ) / 86400000
    );

    const arrivalDay = new Date(
      start_date + 'T12:00:00Z'
    ).getUTCDay();

    if (
      nights < 2 ||
      nights > 60 ||
      (type === 'cabin' && [0, 6].includes(arrivalDay))
    ) {
      return res.status(400).json({
        error: 'Please check your accommodation dates.'
      });
    }

    rangeEnd = type === 'island'
      ? addDays(end_date, 1)
      : end_date;
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({
      error: 'Availability service is unavailable.'
    });
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
    const relatedTypes =
      ['island', 'island_hides'].includes(type)
        ? ['island', 'island_hides']
        : [type];

    const blockResult = await pool.query(
      `SELECT 1
       FROM public.blocked_dates
       WHERE experience = ANY($1::text[])
         AND daterange(
           start_date,
           end_date + 1,
           '[)'
         ) && daterange(
           $2::date,
           $3::date,
           '[)'
         )
         AND (
           $4::text IS NULL
           OR session IS NULL
           OR session = 'all'
           OR session = $4
         )
       LIMIT 1`,
      [relatedTypes, start_date, rangeEnd, selectedSession]
    );

    if (blockResult.rowCount > 0) {
      return res.status(200).json({
        available: false,
        message: 'These dates are unavailable.'
      });
    }

    const bookingResult = await pool.query(
      `SELECT 1
       FROM public.bookings
       WHERE status = ANY($1::text[])
         AND (
           status <> 'pending'
           OR expires_at IS NULL
           OR expires_at > NOW()
         )
         AND (
           (
             type = $2
             AND (
               (
                 $2 IN ('hide', 'island_hides')
                 AND start_date = $3::date
                 AND session = $5
               )
               OR (
                 $2 IN ('cabin', 'island')
                 AND daterange(
                   start_date,
                   CASE
                     WHEN type = 'island'
                     THEN end_date + 1
                     ELSE end_date
                   END,
                   '[)'
                 ) && daterange(
                   $3::date,
                   $4::date,
                   '[)'
               )
             )
           )
           OR (
             $2 IN ('island', 'island_hides')
             AND type IN ('island', 'island_hides')
             AND daterange(
               start_date,
               CASE
                 WHEN type = 'island'
                 THEN end_date + 1
                 ELSE start_date + 1
               END,
               '[)'
             ) && daterange(
               $3::date,
               $4::date,
               '[)'
           )
         )
       LIMIT 1`,
      [ACTIVE, type, start_date, rangeEnd, selectedSession]
    );

    if (bookingResult.rowCount > 0) {
      return res.status(200).json({
        available: false,
        message: 'These dates are already reserved.'
      });
    }

    return res.status(200).json({
      available: true,
      message: 'These dates are currently available to request.'
    });

  } catch (error) {
    console.error(
      'Availability check failed:',
      error.code || error.message
    );

    return res.status(503).json({
      error: 'Unable to check availability right now.'
    });

  } finally {
    await pool.end();
  }
}
