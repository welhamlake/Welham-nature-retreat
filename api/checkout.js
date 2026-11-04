
import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';

const { Pool } = pg;

function validDate(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    type, guests, start_date, end_date,
    session, guest_name, email, phone
  } = req.body || {};

  const name = typeof guest_name === 'string' ? guest_name.trim() : '';
  const guestEmail = typeof email === 'string' ? email.trim() : '';
  const guestPhone = typeof phone === 'string' ? phone.trim() : '';
  const count = Number(guests);

  if (!['cabin', 'hide', 'island', 'island_hides'].includes(type) || ||
      ![1, 2].includes(count) ||
      !name || name.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail) ||
      guestEmail.length > 254 ||
      guestPhone.length > 60 ||
      !validDate(start_date)) {
    return res.status(400).json({
      error: 'Please check your booking details.'
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (start_date < today) {
    return res.status(400).json({
      error: 'Please choose a future date.'
    });
  }

  let totalPence;
  let departure = null;
  let hideSession = null;

  if (type === 'hide' || type === 'island_hides') {
    if (
  (type === 'island_hides' && session !== 'day') ||
  (type === 'hide' && !['day', 'night'].includes(session))
) {
      return res.status(400).json({
        error: 'Please select a hide session.'
      });
    }
    hideSession = session;
    totalPence = count === 1 ? 7500 : 10000;
  } else {
    if (!validDate(end_date)) {
      return res.status(400).json({
        error: 'Please choose a departure date.'
      });
    }

    const start = new Date(start_date + 'T12:00:00Z');
    const end = new Date(end_date + 'T12:00:00Z');
    const nights = Math.round((end - start) / 86400000);

    if (nights < 2 || nights > 60 ||
        [0, 6].includes(start.getUTCDay())) {
      return res.status(400).json({
        error: 'Cabin stays require 2–60 nights and a Monday–Friday arrival.'
      });
    }

    departure = end_date;
    totalPence = nights * 30000;
  }

  if (!process.env.DATABASE_URL ||
      !process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'Booking service is not configured.'
    });
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

  try {
    await pool.query(
      `INSERT INTO public.bookings
       (type, start_date, end_date, session,
        guests, guest_name, email, phone,
        total_pence, deposit_pence, status,
        payment_status, approval_token_hash,
        request_reference, expires_at)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,
        'pending','unpaid',$10,$11,
        NOW() + INTERVAL '24 hours')`,
      [
        type, start_date, departure, hideSession,
        count, name, guestEmail, guestPhone || null,
        totalPence, tokenHash, reference
      ]
    );

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
      return res.status(502).json({
        error: 'Request saved but notification failed. Contact Welham Lake before submitting again.'
      });
    }

    await pool.query(
      `UPDATE public.bookings
       SET email_owner_sent_at = NOW()
       WHERE request_reference = $1`,
      [reference]
    ).catch(error => {
      console.error('Email tracking failed', error.code);
    });

    return res.status(200).json({
      success: true,
      message: 'Booking request saved and sent for review.'
    });

  } catch (error) {
    console.error('Booking failed', error.code || error.message);
    return res.status(500).json({
      error: 'Unable to process booking request.'
    });
  } finally {
    await pool.end();
  }
}
