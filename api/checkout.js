
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    type, guests, start_date, end_date,
    session, guest_name, email, phone
  } = req.body || {};

  if (!guest_name || !email || !start_date || !type) {
    return res.status(400).json({
      error: 'Please complete the required booking details.'
    });
  }

  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: 'Booking email service is not configured.'
    });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Welham Bookings <bookings@welhamlakenature.co.uk>',
        to: ['welhamlake@live.co.uk'],
        reply_to: email,
        subject: 'New Welham Lake booking request',
        text: [
          'NEW BOOKING REQUEST',
          'Approval required - no payment requested.',
          '',
          `Name: ${guest_name}`,
          `Email: ${email}`,
          `Phone: ${phone || 'Not supplied'}`,
          `Experience: ${type}`,
          `Guests: ${guests}`,
          `Arrival: ${start_date}`,
          `Departure: ${end_date || 'Not applicable'}`,
          `Session: ${session || 'Not applicable'}`
        ].join('\n')
      })
    });

    if (!response.ok) {
      return res.status(502).json({
        error: 'Unable to send booking request.'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Booking request sent for review.'
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Booking request service unavailable.'
    });
  }
}
