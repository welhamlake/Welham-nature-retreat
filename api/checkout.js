
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';

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

function responseError(res, status, message) {
  return res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return responseError(res, 405, 'Method not allowed');
  }

  const {
    type, guests, start_date, end_date, session,
    guest_name, email, phone
  } = req.body || {};

  const name =
    typeof guest_name === 'string' ? guest_name.trim() : '';
  const guestEmail =
    typeof email === 'string' ? email.trim() : '';
  const guestPhone =
    typeof phone === 'string' ? phone.trim() : '';
  const count = Number(guests);

  if (
    !TYPES.includes(type) ||
    ![1, 2].includes(count) ||
    !name ||
    name.length > 120 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail) ||
    guestEmail.length > 254 ||
    guestPhone.length > 60 ||
    !validDate(start_date)
  ) {
    return responseError(
      res, 400, 'Please check your booking details.'
    );
  }

  const today = ukToday();

  if (start_date < today) {
    return responseError(
      res, 400, 'Please choose a current or future date.'
    );
  }

  if (
    ['island', 'island_hides'].includes(type) &&
    start_date < '2027-03-01'
  ) {
    return responseError(
      res, 400, 'Island bookings start from 1 March 2027.'
    );
  }

  if (
    type === 'island_hides' &&
    start_date > addDays(today, 14)
  ) {
    return responseError(
      res, 400,
      'Island hides can only be booked up to 14 days ahead.'
    );
  }

  const isHide = type === 'hide' || type === 'island_hides';

  let totalPence;
  let departure = null;
  let hideSession = null;

  if (isHide) {
    if (
      (type === 'island_hides' && session !== 'day') ||
      (type === 'hide' && !['day', 'night'].includes(session))
    ) {
      return responseError(
        res, 400, 'Please select an available hide session.'
      );
    }

    hideSession = session;
    totalPence = count === 1 ? 7500 : 10000;
  } else {
    if (!validDate(end_date)) {
      return responseError(
        res, 400, 'Please choose a departure date.'
      );
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
      return responseError(
        res, 400,
        type === 'cabin'
          ? 'Cabin stays require 2–60 nights and a Monday–Friday arrival.'
          : 'Island Glamping stays require 2–60 nights.'
      );
    }

    departure = end_date;
    totalPence = nights *
      (type === 'island' ? 25000 : 30000);
  }

  if (!process.env.DATABASE_URL || !process.env.RESEND_API_KEY) {
    return responseError(
      res, 503, 'Booking service is not configured.'
    );
  }

  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256')
    .update(token).digest('hex');
  const reference = 'WEL-' +
    randomBytes(6).toString('hex').toUpperCase();

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

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Prevent two checkout requests reserving the same dates.
    await client.query(
      'SELECT pg_advisory_xact_lock(918273645)'
    );

    // Expire overdue pending holds.
    await client.query(`
      UPDATE public.bookings
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);

    // Accommodation checkout is normally exclusive.
    // Island Glamping also reserves its checkout day.
    const rangeEnd = isHide
      ? addDays(start_date, 1)
      : type === 'island'
        ? addDays(departure, 1)
        : departure;

    const relatedTypes =
      ['island', 'island_hides'].includes(type)
        ? ['island', 'island_hides']
        : [type];

    // A block for either island experience prevents
    // overlapping island use, regardless of session.
    // For the separate hide, day and night remain independent.
    const blocks = await client.query(
      `SELECT 1
       FROM public.blocked_dates
       WHERE experience = ANY($1::text[])
         AND daterange(
           start_date, end_date + 1, '[)'
         ) && daterange(
           $2::date, $3::date, '[)'
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

    if (blocks.rowCount) {
      await client.query('ROLLBACK');
      return responseError(
        res, 409,
        'Those dates or that hide session are unavailable. Please choose another.'
      );
    }

    // Compare booking date ranges.
    // Island Glamping reserves arrival through checkout day.
    // Island hide sessions reserve their selected day.
    const conflicts = await client.query(
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
                   $3::date, $4::date, '[)'
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
               $3::date, $4::date, '[)'
           )
         )
       LIMIT 1`,
      [
        ACTIVE, type, start_date, rangeEnd, hideSession
      ]
    );

    if (conflicts.rowCount) {
      await client.query('ROLLBACK');
      return responseError(
        res, 409,
        'These dates are already reserved. Please choose another.'
      );
    }

    await client.query(
      `INSERT INTO public.bookings
       (
         type, start_date, end_date, session, guests,
         guest_name, email, phone, total_pence,
         deposit_pence, status, payment_status,
         approval_token_hash, request_reference, expires_at
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,
         0,'pending','unpaid',$10,$11,
         NOW() + INTERVAL '24 hours'
       )`,
      [
        type, start_date, departure, hideSession,
        count, name, guestEmail, guestPhone || null,
        totalPence, tokenHash, reference
      ]
    );

    await client.query('COMMIT');

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error(
      'Booking failed:', error.code || error.message
    );

    if (
      error.code === '23505' ||
      error.code === '23P01'
    ) {
      return responseError(
        res, 409,
        'These dates are already reserved. Please choose another.'
      );
    }

    return responseError(
      res, 500, 'Unable to process booking request.'
    );

  } finally {
    if (client) client.release();
  }

  try {
    const response = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Welham Bookings <bookings@welhamlakenature.co.uk>',
          to: ['welhamlake@live.co.uk'],
          reply_to: guestEmail,
          subject: 'New Welham Lake booking request',
          text: [
            'NEW BOOKING REQUEST',
            'Approval required - no payment requested.',
            '',
            `Reference: ${reference}`,
            `Name: ${name}`,
            `Email: ${guestEmail}`,
            `Phone: ${guestPhone || 'Not supplied'}`,
            `Experience: ${type}`,
            `Guests: ${count}`,
            `Arrival: ${start_date}`,
            `Departure: ${departure || 'Not applicable'}`,
            `Session: ${hideSession || 'Not applicable'}`,
            `Total: £${(totalPence / 100).toFixed(2)}`,
            '',
            'Request saved in database.',
            `Review booking: https://welham-nature-retreat.vercel.app/api/approve?token=${token}`
          ].join('\n')
        })
      }
    );

    if (!response.ok) {
      console.error('Email failed', response.status);
      return responseError(
        res, 502,
        'Request saved but notification failed. Contact Welham Lake before submitting again.'
      );
    }

    await pool.query(
      `UPDATE public.bookings
       SET email_owner_sent_at = NOW()
       WHERE request_reference = $1`,
      [reference]
    ).catch(error => {
      console.error(
        'Email tracking failed:', error.code
      );
    });

    return res.status(200).json({
      success: true,
      message: 'Booking request saved and sent for review.'
    });

  } catch (error) {
    console.error(
      'Booking notification failed:',
      error.code || error.message
    );

    return responseError(
      res, 502,
      'Request saved but notification failed. Contact Welham Lake before submitting again.'
    );

  } finally {
    await pool.end();
  }
}
