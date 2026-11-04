
import pg from 'pg';

const { Pool } = pg;

const TYPES = ['cabin', 'hide', 'island', 'island_hides'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) return false;

  const d = new Date(value + 'T12:00:00Z');

  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
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
    parts.find(p => p.type === type)?.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function error(res, status, message) {
  return res.status(status).json({
    available: false,
    error: message
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return error(res, 405, 'Method not allowed');
  }

  const {
    type,
    start_date,
    end_date,
    session
  } = req.query || {};

  if (
    !TYPES.includes(type) ||
    !validDate(start_date)
  ) {
    return error(res, 400, 'Please choose a valid experience and date.');
  }

  const today = ukToday();

  if (start_date < today) {
    return error(res, 400, 'Please choose a future or current date.');
  }

  if (
    (type === 'island' || type === 'island_hides') &&
    start_date < '2027-03-01'
  ) {
    return error(res, 400, 'Island bookings open from March 2027.');
  }

  if (
    type === 'island_hides' &&
    start_date > addDays(today, 14)
  ) {
    return error(
      res,
      400,
      'Island wildlife hides can only be booked 14 days ahead.'
    );
  }

  const isHide = type === 'hide' || type === 'island_hides';

  let departure = null;
  let hideSession = null;

  if (isHide) {
    if (
      (type === 'island_hides' && session !== 'day') ||
      (type === 'hide' && !['day', 'night'].includes(session))
    ) {
      return error(res, 400, 'Please select a valid hide session.');
    }

    hideSession = session;
  } else {
    if (!validDate(end_date)) {
      return error(res, 400, 'Please choose a departure date.');
    }

    const nights = Math.round(
      (
        new Date(end_date + 'T12:00:00Z') -
        new Date(start_date + 'T12:00:00Z')
      ) / 86400000
    );

    if (nights < 2 || nights > 60) {
      return error(
        res,
        400,
        'Accommodation bookings require between 2 and 60 nights.'
      );
    }

    if (type === 'cabin') {
      const arrivalDay = new Date(
        start_date + 'T12:00:00Z'
      ).getUTCDay();

      if (arrivalDay === 0 || arrivalDay === 6) {
        return error(
          res,
          400,
          'Cabin arrivals are Monday to Friday only.'
        );
      }
    }

    departure = end_date;
  }

  if (!process.env.DATABASE_URL) {
    return error(res, 503, 'Availability service is not configured.');
  }

  const rangeEnd = isHide
    ? addDays(start_date, 1)
    : type === 'island'
      ? addDays(departure, 1)
      : departure;

  const relatedTypes =
    type === 'island' || type === 'island_hides'
      ? ['island', 'island_hides']
      : [type];

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
    const blocks = await pool.query(
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
           $4::boolean = true
           OR session IS NULL
           OR session = 'all'
           OR session = $5
         )
       LIMIT 1`,
      [
        relatedTypes,
        start_date,
        rangeEnd,
        relatedTypes.includes('island'),
        hideSession
      ]
    );

    if (blocks.rowCount > 0) {
      return res.status(200).json({
        available: false,
        message: 'These dates are unavailable.'
      });
    }

    const bookings = await pool.query(
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
      [
        ACTIVE,
        type,
        start_date,
        rangeEnd,
        hideSession
      ]
    );

    if (bookings.rowCount > 0) {
      return res.status(200).json({
        available: false,
        message: 'These dates are unavailable.'
      });
    }

    return res.status(200).json({
      available: true,
      message: 'These dates are available to request.'
    });

  } catch (err) {
    console.error(
      'Availability check failed:',
      err.code || err.message
    );

    return error(
      res,
      500,
      'Unable to check availability. Please try again.'
    );

  } finally {
    await pool.end();
  }
}
