
import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Resend } from 'resend';

const { Pool } = pg;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>';
const OWNER = 'welhamlake@live.co.uk';

function passwordMatches(input, expected) {
  if (typeof input !== 'string' || !expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

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
<style>
body{font:16px Arial,sans-serif;background:#f3f5f1;color:#243328;padding:20px}
main{max-width:550px;margin:40px auto;background:white;padding:25px;border-radius:12px}
a{display:inline-block;background:#234735;color:white;padding:12px 18px;border-radius:8px;text-decoration:none}
</style>
</head>
<body><main>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
<a href="/api/calendar">Return to calendar</a>
</main></body></html>`;
}

function dateOnly(value) {
  if (!value) return '';
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

async function sendCancellationEmails(booking) {
  if (!resend) {
    return {
      guest: false,
      owner: false,
      errors: ['Email service is not configured']
    };
  }

  const reference = String(booking.request_reference);
  const name = String(booking.guest_name || 'Guest');
  const type = String(booking.type || 'Accommodation or wildlife hide');
  const dates = `${dateOnly(booking.start_date)} to ${dateOnly(booking.end_date || booking.start_date)}`;
  const paid = String(booking.payment_status || '').toLowerCase() === 'paid';
  const subject = `Booking cancelled - ${reference}`;

  const guestText = [
    `Hello ${name},`,
    '',
    'This email confirms that your Welham Nature Retreat booking has been cancelled.',
    '',
    `Booking reference: ${reference}`,
    `Experience: ${type}`,
    `Dates: ${dates}`,
    ...(booking.session ? [`Session: ${booking.session}`] : []),
    '',
    paid
      ? 'Your payment record remains on file. Any applicable refund will be handled separately; this email does not confirm a refund.'
      : 'No refund is confirmed or processed by this email.',
    '',
    'If you have any questions, please reply to this email.',
    '',
    'Welham Nature Retreat'
  ].join('\n');

  const ownerText = [
    'A booking was cancelled in the Welham Nature Retreat owner calendar.',
    '',
    `Guest: ${name}`,
    `Guest email: ${booking.email || '(missing)'}`,
    `Booking reference: ${reference}`,
    `Experience: ${type}`,
    `Dates: ${dates}`,
    `Payment status: ${booking.payment_status || 'unknown'}`,
    '',
    'Check any refund arrangements separately.'
  ].join('\n');

  const result = {
    guest: false,
    owner: false,
    errors: []
  };

  if (booking.email) {
    try {
      const sent = await resend.emails.send({
        from: FROM,
        to: [booking.email],
        subject,
        text: guestText
      });

      if (sent.error) {
        throw new Error(sent.error.message || 'Resend rejected guest email');
      }

      result.guest = true;
    } catch (err) {
      console.error('Guest cancellation email failed:', err.message);
      result.errors.push('guest email');
    }
  } else {
    result.errors.push('guest email address missing');
  }

  try {
    const sent = await resend.emails.send({
      from: FROM,
      to: [OWNER],
      subject: `Owner copy: ${subject}`,
      text: ownerText
    });

    if (sent.error) {
      throw new Error(sent.error.message || 'Resend rejected owner email');
    }

    result.owner = true;
  } catch (err) {
    console.error('Owner cancellation email failed:', err.message);
    result.errors.push('owner email');
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send(page(
      'Action unavailable',
      'This action must be submitted from your owner calendar.'
    ));
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  if (!passwordMatches(
    body.password,
    process.env.BOOKING_ADMIN_PASSWORD
  )) {
    return res.status(403).send(page(
      'Incorrect password',
      'No changes were made.'
    ));
  }

  const action = String(body.action || '');
  const reference = String(body.request_reference || '');

  if (
    !['mark_paid', 'release_booking', 'cancel_booking'].includes(action) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(reference)
  ) {
    return res.status(400).send(page(
      'Invalid booking action',
      'No changes were made.'
    ));
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).send(page(
      'Database unavailable',
      'Please try again later.'
    ));
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

  const client = await pool.connect().catch(() => null);

  if (!client) {
    await pool.end();
    return res.status(503).send(page(
      'Connection unavailable',
      'No changes were made.'
    ));
  }

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, request_reference, guest_name, email,
              type, start_date, end_date, session,
              status, payment_status, payment_due_at
       FROM public.bookings
       WHERE request_reference = $1
       FOR UPDATE`,
      [reference]
    );

    if (result.rowCount !== 1) {
      await client.query('ROLLBACK');
      return res.status(409).send(page(
        'Booking not found or ambiguous',
        'No changes were made.'
      ));
    }

    const booking = result.rows[0];
    const status = String(booking.status || '').toLowerCase();
    const payment = String(booking.payment_status || '').toLowerCase();

    if (action === 'cancel_booking') {
      if (!['pending', 'approved', 'confirmed'].includes(status)) {
        await client.query('ROLLBACK');
        return res.status(409).send(page(
          'Booking cannot be cancelled',
          'This booking is already cancelled or inactive. No additional email was sent.'
        ));
      }

      await client.query(
        `UPDATE public.bookings
         SET status = 'cancelled'
         WHERE id = $1`,
        [booking.id]
      );

      await client.query('COMMIT');

      // Send emails only after cancellation is saved.
      const sent = await sendCancellationEmails(booking);

      return res.status(200).send(page(
        'Booking cancelled',
        `Booking ${reference} has been cancelled. Its dates should now be released. Guest email: ${sent.guest ? 'accepted by email provider' : 'NOT sent'}. Owner email: ${sent.owner ? 'accepted by email provider' : 'NOT sent'}.${sent.errors.length ? ' Please check the missing emails manually; do not cancel the booking again.' : ''} Any refund must be handled separately.`
      ));
    }

    if (action === 'mark_paid') {
      if (status !== 'approved' || payment === 'paid') {
        await client.query('ROLLBACK');
        return res.status(409).send(page(
          'Booking cannot be marked paid',
          'Only approved, unpaid bookings can be confirmed.'
        ));
      }

      await client.query(
        `UPDATE public.bookings
         SET payment_status = 'paid',
             status = 'confirmed'
         WHERE id = $1`,
        [booking.id]
      );

      await client.query('COMMIT');

      return res.status(200).send(page(
        'Payment recorded',
        `Booking ${reference} has been marked as paid and confirmed.`
      ));
    }

    if (
      status !== 'approved' ||
      payment === 'paid' ||
      !booking.payment_due_at ||
      new Date(booking.payment_due_at).getTime() > Date.now()
    ) {
      await client.query('ROLLBACK');
      return res.status(409).send(page(
        'Booking cannot be released',
        'Only approved, unpaid bookings past their payment deadline can be released.'
      ));
    }

    await client.query(
      `UPDATE public.bookings
       SET status = 'cancelled'
       WHERE id = $1`,
      [booking.id]
    );

    await client.query('COMMIT');

    return res.status(200).send(page(
      'Booking released',
      `Booking ${reference} has been cancelled and its dates released. No cancellation email was sent for an automatic payment-deadline release.`
    ));

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    console.error(
      'Booking management error:',
      error.code || error.message
    );

    return res.status(500).send(page(
      'Unable to complete action',
      'Please check the calendar before retrying. If the booking is cancelled, do not repeat the action; email delivery may have failed.'
    ));

  } finally {
    client.release();
    await pool.end();
  }
}
