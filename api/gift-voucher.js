
import { Resend } from 'resend';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
const DATABASE_URL = process.env.DATABASE_URL;
const { Pool } = pg;
const vouchers = {
  'Wildlife Hide - One Person - £75': 75,
  'Wildlife Hide - Two People - £100': 100,
  'Luxury Cabin - Two Nights - £600': 600,
  'Monetary Voucher - £50': 50,
  'Monetary Voucher - £100': 100,
  'Monetary Voucher - £200': 200
};

function clean(value, max = 200) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({
      error: 'Email service unavailable'
    });
  }

  const body = req.body || {};

  const voucher = clean(body.voucher);
  const buyer = clean(body.buyer);
  const email = clean(body.email);
  const recipient = clean(body.recipient);
  const message = clean(body.message, 500);

  if (
    !Object.hasOwn(vouchers, voucher) ||
    !buyer ||
    !recipient ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({
      error: 'Please check your voucher details'
    });
  }

  const reference =
    'WGV-' + randomUUID().slice(0, 8).toUpperCase();

  const details = [
    'NEW WELHAM LAKE GIFT VOUCHER REQUEST',
    '',
    `Reference: ${reference}`,
    `Voucher: ${voucher}`,
    `Amount: £${vouchers[voucher]}`,
    '',
    `Customer: ${buyer}`,
    `Customer email: ${email}`,
    `Recipient: ${recipient}`,
    `Personal message: ${message || 'None'}`,
    '',
    'STATUS: REQUEST ONLY - NOT PAID',
    '',
    'Check payment before issuing a voucher.'
  ].join('\n');

  try {
    const resend = new Resend(
      process.env.RESEND_API_KEY
    );

    const result = await resend.emails.send({
      from: 'Welham Nature Retreat <bookings@welhamlakenature.co.uk>',
      to: ['welhamlake@live.co.uk'],
      replyTo: email,
      subject: `Gift voucher request - ${reference}`,
      text: details
    });

    if (result.error) {
      throw new Error('Email delivery failed');
    }

    return res.status(200).json({
      success: true,
      reference,
      message: 'Your voucher request has been received.'
    });

  } catch (error) {
    console.error('Voucher email failed', error);

    return res.status(500).json({
      error: 'Unable to send request. Please try again.'
    });
  }
}
