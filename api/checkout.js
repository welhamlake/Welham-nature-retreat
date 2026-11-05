
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';

const { Pool } = pg;

const TYPES = ['cabin', 'cabin_hide', 'hide', 'island', 'island_hides'];
const ACTIVE = ['pending', 'approved', 'confirmed', 'paid'];

const EXPERIENCE_NAMES = {
  cabin: 'Luxury Cabin',
  cabin_hide: 'Luxury Cabin Wildlife Hide',
  hide: 'Separate Wildlife Hide',
  island: 'Island Glamping',
  island_hides: 'Island Wildlife Hides'
};

const BLOCK_NAMES = {
  cabin: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  cabin_hide: ['cabin', 'Luxury Cabin', 'cabin_hide', 'Luxury Cabin Wildlife Hide'],
  hide: ['hide', 'Separate Wildlife Hide'],
  island: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides'],
  island_hides: ['island', 'Island Glamping', 'island_hides', 'Island Wildlife Hides']
};

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const d = new Date(value + 'T12:00:00Z');

  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
}

function dateOnly(value) {
  if (!value) return '';

  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function addDays(value, days) {
  const d = new Date(value + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function responseError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isIsland(type) {
  return ['island', 'island_hides'].includes(type);
}

function isCabin(type) {
  return ['cabin', 'cabin_hide'].includes(type);
}

function isHide(type) {
  return ['hide', 'island_hides', 'cabin_hide'].includes(type);
}

function bookingRange(type, start, end) {
  if (type === 'hide') {
    return {
      start,
      end: addDays(end || start, 1)
    };
  }

  if (['island_hides', 'cabin_hide'].includes(type)) {
    return {
      start,
      end: addDays(start, 1)
    };
  }

  return {
    start,
    end: ['island', 'cabin'].includes(type)
      ? addDays(end, 1)
      : end
  };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function bookingConflict(request, existing) {
  const existingType = String(existing.type || '');

  const related =
    request.type === existingType ||
    (isIsland(request.type) && isIsland(existingType)) ||
    (isCabin(request.type) && isCabin(existingType));

  if (!related) return false;

  const start = dateOnly(existing.start_date);
  const end = dateOnly(existing.end_date) || start;

  if (!start) return false;

  const existingRange = bookingRange(existingType, start, end);

  if (!overlaps(request.range, existingRange)) return false;

  if (isIsland(request.type) || isCabin(request.type)) {
    return true;
  }

  const existingSession = String(existing.session || '');

  return !existingSession ||
    existingSession === 'all' ||
    existingSession === request.session;
}

function blockConflict(request, block) {
  if (!BLOCK_NAMES[request.type].includes(String(block.experience || ''))) {
    return false;
  }

  const start = dateOnly(block.start_date);
  const end = dateOnly(block.end_date);

  if (!start || !end) return false;

  if (!overlaps(request.range, {
    start,
    end: addDays(end, 1)
  })) return false;

  if (isIsland(request.type) || isCabin(request.type)) {
    return true;
  }

  const blockSession = String(block.session || 'all');

  return blockSession === 'all' ||
    blockSession === request.session;
}

async function sendOwnerEmail(details) {
  const {
    token, reference, name, guestEmail, guestPhone,
    type, count, startDate, departure, session,
    sessionCount, totalPence
  } = details;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Welham Bookings <bookings@welhamlakenature.co.uk>',
      to: ['welhamlake@live.co.uk'],
      reply_to: guestEmail,
      subject: `New Welham booking request ${reference}`,
      text: [
        'NEW BOOKING REQUEST',
        '',
        'Approval required.',
        'No payment has been requested.',
        '',
        `Reference: ${reference}`,
        `Name: ${name}`,
        `Email: ${guestEmail}`,
        `Phone: ${guestPhone || 'Not supplied'}`,
        `Experience: ${EXPERIENCE_NAMES[type]}`,
        `Guests: ${count}`,
        `First date: ${startDate}`,
        `Final session date / Departure: ${departure || startDate}`,
        `Session: ${session || 'Not applicable'}`,
        `Number of hide sessions: ${isHide(type) ? sessionCount : 'Not applicable'}`,
        `Total: £${(totalPence / 100).toFixed(2)}`,
        '',
        'The booking is held pending approval.',
        'Pending requests expire after 24 hours.',
        '',
        'Review and approve:',
        'https://welham-nature-retreat.vercel.app/api/approve?token=' + token
      ].join('\n')
    })
  });

  if (!response.ok) {
    console.error('Owner booking email failed:', response.status);
    return false;
  }

  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return responseError(res, 405, 'Method not allowed.');
  }

  const body = typeof req.body === 'string'
    ? (() => {
        try { return JSON.parse(req.body); }
        catch { return {}; }
      })()
    : req.body || {};

  const {
    type, guests, start_date, end_date,
    session, guest_name, email, phone
  } = body;

  const name = typeof guest_name === 'string'
    ? guest_name.trim()
    : '';

  const guestEmail = typeof email === 'string'
    ? email.trim()
    : '';

  const guestPhone = typeof phone === 'string'
    ? phone.trim()
    : '';

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
      res, 400,
      'Please check your booking details.'
    );
  }

  const today = ukToday();

  if (start_date < today) {
    return responseError(
      res, 400,
      'Please choose a current or future date.'
    );
  }

  if (isIsland(type) && start_date < '2027-03-01') {
    return responseError(
      res, 400,
      'Island bookings start from 1 March 2027.'
    );
  }

  if (
    ['island_hides', 'cabin_hide'].includes(type) &&
    start_date > addDays(today, 14)
  ) {
    return responseError(
      res, 400,
      'This wildlife hide can only be booked up to 14 days ahead.'
    );
  }

  let totalPence;
  let departure = null;
  let hideSession = null;
  let sessionCount = 1;

  if (isHide(type)) {
    if (
      (['island_hides', 'cabin_hide'].includes(type) &&
        session !== 'day') ||
      (type === 'hide' &&
        !['day', 'night'].includes(session))
    ) {
      return responseError(
        res, 400,
        'Please select an available hide session.'
      );
    }

    hideSession = session;

    if (type === 'hide') {
      if (end_date !== undefined &&
          end_date !== null &&
          end_date !== '') {
        if (!validDate(end_date)) {
          return responseError(
            res, 400,
            'Please choose a valid final session date.'
          );
        }

        sessionCount = daysBetween(start_date, end_date) + 1;

        if (sessionCount < 1 || sessionCount > 7) {
          return responseError(
            res, 400,
            'Choose between 1 and 7 consecutive sessions.'
          );
        }

        departure = end_date;
      } else {
        departure = start_date;
      }
    }

    totalPence = (count === 1 ? 7500 : 10000) * sessionCount;

  } else {
    if (!validDate(end_date)) {
      return responseError(
        res, 400,
        'Please choose a departure date.'
      );
    }

    const nights = daysBetween(start_date, end_date);

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
      res, 503,
      'Booking service is not configured.'
    );
  }

  const request = {
    type,
    session: hideSession,
    range: bookingRange(
      type,
      start_date,
      departure || start_date
    )
  };

  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256')
    .update(token)
    .digest('hex');

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
  let saved = false;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Prevent simultaneous checkout requests creating double bookings.
    await client.query(
      'SELECT pg_advisory_xact_lock(918273645)'
    );

    await client.query(`
      UPDATE public.bookings
      SET status = 'expired'
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `);

    const blockResult = await client.query(`
      SELECT experience, start_date, end_date, session
      FROM public.blocked_dates
      WHERE end_date >= $1::date
        AND start_date < $2::date
    `, [
      request.range.start,
      request.range.end
    ]);

    if (
      blockResult.rows.some(
        block => blockConflict(request, block)
      )
    ) {
      await client.query('ROLLBACK');

      return responseError(
        res, 409,
        'One or more selected sessions are blocked. Please choose another.'
      );
    }

    const bookingResult = await client.query(`
      SELECT type, start_date, end_date,
             session, status, expires_at
      FROM public.bookings
      WHERE status = ANY($1::text[])
        AND start_date < $2::date
        AND (
          end_date IS NULL OR
          end_date >= $3::date
        )
    `, [
      ACTIVE,
      request.range.end,
      addDays(request.range.start, -1)
    ]);

    const now = Date.now();

    const conflict = bookingResult.rows.some(booking => {
      if (
        booking.status === 'pending' &&
        booking.expires_at &&
        new Date(booking.expires_at).getTime() <= now
      ) {
        return false;
      }

      return bookingConflict(request, booking);
    });

    if (conflict) {
      await client.query('ROLLBACK');

      return responseError(
        res, 409,
        'One or more selected sessions are already reserved.'
      );
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
        0,'pending','unpaid',$10,$11,
        NOW() + INTERVAL '24 hours'
      )
    `, [
      type,
      start_date,
      departure,
      hideSession,
      count,
      name,
      guestEmail,
      guestPhone || null,
      totalPence,
      tokenHash,
      reference
    ]);

    await client.query('COMMIT');
    saved = true;

  } catch (error) {
    if (client && !saved) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error(
      'Booking checkout error:',
      error.code || error.message
    );

    if (saved) {
      return responseError(
        res, 502,
        'Booking may have been saved. Contact Welham Lake before trying again.'
      );
    }

    if (['23505', '23P01'].includes(error.code)) {
      return responseError(
        res, 409,
        'These dates are already reserved.'
      );
    }

    return responseError(
      res, 500,
      'Unable to process booking request.'
    );

  } finally {
    if (client) client.release();
  }

  try {
    const sent = await sendOwnerEmail({
      token,
      reference,
      name,
      guestEmail,
      guestPhone,
      type,
      count,
      startDate: start_date,
      departure,
      session: hideSession,
      sessionCount,
      totalPence
    });

    if (!sent) {
      return responseError(
        res, 502,
        'Booking saved, but notification failed. Contact Welham Lake before submitting again.'
      );
    }

    await pool.query(`
      UPDATE public.bookings
      SET email_owner_sent_at = NOW()
      WHERE request_reference = $1
    `, [reference]).catch(error => {
      console.error(
        'Email tracking error:',
        error.code || error.message
      );
    });

    return res.status(200).json({
      success: true,
      reference,
      message: 'Booking request saved and sent for review.'
    });

  } catch (error) {
    console.error(
      'Booking email error:',
      error.code || error.message
    );

    return responseError(
      res, 502,
      'Booking saved, but notification failed. Contact Welham Lake before submitting again.'
    );

  } finally {
    await pool.end();
  }
}
