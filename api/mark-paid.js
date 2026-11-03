
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';

const { Pool } = pg;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function page(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
</head>
<body style="font:16px Arial,sans-serif;max-width:500px;margin:40px auto;padding:20px">
<h1>Welham Nature Retreat</h1>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(
      page('Method not allowed', 'Use the secure payment form.')
    );
  }

  const { reference, owner_password } = req.body || {};

  if (!passwordMatches(
    owner_password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(
      page('Access denied', 'Incorrect owner password.')
    );
  }

  if (typeof reference !== 'string' ||
      !/^WEL-[A-Z0-9]+$/.test(reference)) {
    return res.status(400).send(
      page('Invalid reference', 'Check the booking reference.')
    );
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(
      page('Unavailable', 'Database connection unavailable.')
    );
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
    const result = await pool.query(
      `UPDATE public.bookings
       SET payment_status = 'paid',
           paid_at = NOW(),
           status = 'confirmed'
       WHERE request_reference = $1
         AND status = 'approved'
         AND payment_status = 'unpaid'
       RETURNING request_reference, guest_name, email,
                 type, start_date, end_date, session,
                 total_pence`,
      [reference]
    );

    if (!result.rows.length) {
      return res.status(409).send(
        page(
          'Cannot mark as paid',
          'This booking is not awaiting payment, or has already been processed.'
        )
      );
    }

    const booking = result.rows[0];

    try {
      if (!process.env.RESEND_API_KEY) {
        throw new Error('Email service not configured');
      }

      const resend = new Resend(process.env.RESEND_API_KEY);

      const details = [
        `Hello ${booking.guest_name},`,
        '',
        'Thank you for your payment.',
        'Your Welham Nature Retreat booking is confirmed.',
        '',
        `Booking reference: ${booking.request_reference}`,
        `Experience: ${booking.type}`,
        `Arrival / session date: ${formatDate(booking.start_date)}`,
        ...(booking.end_date
          ? [`Departure date: ${formatDate(booking.end_date)}`]
          : []),
        ...(booking.session
          ? [`Session: ${booking.session}`]
          : []),
        `Payment received: £${(booking.total_pence / 100).toFixed(2)}`,
        '',
        'We look forward to welcoming you.',
        '',
        'Welham Nature Retreat'
      ].join('\n');

      const emailResult = await resend.emails.send({
        from: 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>',
        to: [booking.email],
        subject: `Booking confirmed - ${booking.request_reference}`,
        text: details,
        idempotencyKey: `payment-confirmation/${booking.request_reference}`
      });

      if (emailResult.error || !emailResult.data?.id) {
        throw new Error('Confirmation email not accepted');
      }

      await pool.query(
        `UPDATE public.bookings
         SET email_confirmation_sent_at = NOW()
         WHERE request_reference = $1
           AND email_confirmation_sent_at IS NULL`,
        [booking.request_reference]
      );

    } catch (emailError) {
      console.error('Confirmation email error:', emailError.message);

      return res.status(200).send(
        page(
          'Payment recorded - email needs attention',
          'The booking is confirmed and payment recorded, but the confirmation email could not be completed. Please check Resend and the booking record before sending manually.'
        )
      );
    }

    return res.status(200).send(
      page(
        'Payment recorded',
        `Payment recorded for ${reference}. Confirmation email accepted for delivery.`
      )
    );

  } catch (error) {
    console.error('Mark paid error:', error.code || error.message);
    return res.status(500).send(
      page('Error', 'Unable to record this payment.')
    );
  } finally {
    await pool.end();
  }
}
