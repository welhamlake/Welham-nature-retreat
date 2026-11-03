
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';

const { Pool } = pg;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[c]);
}

function page(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} | Welham</title>
<style>
body{font:16px Arial,sans-serif;background:#f3f5f1;color:#243328;padding:20px}
main{max-width:500px;margin:30px auto;background:white;padding:25px;border-radius:12px}
a{color:#234735}
</style>
</head>
<body><main>
<h1>Welham Nature Retreat</h1>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
<p><a href="/api/dashboard">Return to dashboard login</a></p>
</main></body></html>`;
}

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function getBody(req) {
  if (typeof req.body === 'string') {
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return req.body || {};
}

async function sendPaymentEmail(booking) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Email service unavailable');
  }

  const required = [
    'BANK_ACCOUNT_NAME',
    'BANK_SORT_CODE',
    'BANK_ACCOUNT_NUMBER'
  ];

  if (required.some(key => !process.env[key])) {
    throw new Error('Bank details unavailable');
  }

  const deadline = new Date(booking.payment_due_at)
    .toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      dateStyle: 'full',
      timeStyle: 'short'
    });

  const message = [
    `Hello ${booking.guest_name},`,
    '',
    'Your Welham Nature Retreat booking has been approved.',
    '',
    `Booking reference: ${booking.request_reference}`,
    `Total to pay: £${(booking.total_pence / 100).toFixed(2)}`,
    '',
    'Please make a bank transfer using:',
    `Account name: ${process.env.BANK_ACCOUNT_NAME}`,
    `Sort code: ${process.env.BANK_SORT_CODE}`,
    `Account number: ${process.env.BANK_ACCOUNT_NUMBER}`,
    `Payment reference: ${booking.request_reference}`,
    '',
    `Payment deadline: ${deadline} (UK time)`,
    '',
    'Please pay within 24 hours of approval.',
    'Your booking is not confirmed until payment has been verified.',
    '',
    'Thank you,',
    'Welham Nature Retreat'
  ].join('\n');

  const resend = new Resend(process.env.RESEND_API_KEY);

  const result = await resend.emails.send({
    from: 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>',
    to: [booking.email],
    subject: `Payment instructions - ${booking.request_reference}`,
    text: message
  });

  if (result.error || !result.data?.id) {
    throw new Error('Payment email not accepted');
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(
      page('Method not allowed', 'Use the secure booking dashboard.')
    );
  }

  const { reference, decision, owner_password } = getBody(req);

  if (!passwordMatches(owner_password, process.env.BOOKING_ADMIN_PASSWORD)) {
    return res.status(403).send(
      page('Access denied', 'Incorrect owner password.')
    );
  }

  if (typeof reference !== 'string' ||
      !/^WEL-[A-Z0-9]+$/.test(reference) ||
      !['approve', 'decline'].includes(decision)) {
    return res.status(400).send(
      page('Invalid request', 'Check the booking details.')
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
    const newStatus = decision === 'approve'
      ? 'approved'
      : 'declined';

    const result = await pool.query(
      `UPDATE public.bookings
       SET status = $1,
           approved_at = CASE
             WHEN $1 = 'approved' THEN NOW()
             ELSE approved_at
           END,
           payment_due_at = CASE
             WHEN $1 = 'approved'
             THEN NOW() + INTERVAL '24 hours'
             ELSE payment_due_at
           END
       WHERE request_reference = $2
         AND status = 'pending'
       RETURNING request_reference, guest_name, email,
                 total_pence, payment_due_at`,
      [newStatus, reference]
    );

    if (!result.rows.length) {
      return res.status(409).send(
        page('Cannot process booking',
          'This booking is no longer pending or does not exist.')
      );
    }

    if (decision === 'approve') {
      try {
        await sendPaymentEmail(result.rows[0]);

        await pool.query(
          `UPDATE public.bookings
           SET email_payment_sent_at = NOW()
           WHERE request_reference = $1
             AND email_payment_sent_at IS NULL`,
          [reference]
        );
      } catch (error) {
        console.error('Dashboard payment email error:', error.message);

        return res.status(200).send(
          page('Booking approved - email needs attention',
            'The booking was approved, but the payment email could not be completed. Check Resend before contacting the customer.')
        );
      }
    }

    return res.status(200).send(
      page(
        decision === 'approve' ? 'Booking approved' : 'Booking declined',
        decision === 'approve'
          ? 'The booking was approved and payment instructions were accepted for delivery.'
          : 'The booking has been declined. No customer decline email has been sent.'
      )
    );

  } catch (error) {
    console.error('Dashboard action error:', error.code || error.message);

    if (error.code === '23P01' || error.code === '23505') {
      return res.status(409).send(
        page('Dates unavailable',
          'These dates are already booked. The request was not approved.')
      );
    }

    return res.status(500).send(
      page('Error', 'Unable to process the booking.')
    );
  } finally {
    await pool.end();
  }
}
