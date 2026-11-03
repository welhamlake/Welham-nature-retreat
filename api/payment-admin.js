
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Management | Welham Nature Retreat</title>
<style>
body {
  font: 16px Arial, sans-serif;
  background: #f7f4ed;
  color: #172c24;
  padding: 20px;
}
main {
  max-width: 450px;
  margin: 35px auto;
  background: white;
  padding: 25px;
  border-radius: 12px;
}
input, button {
  box-sizing: border-box;
  width: 100%;
  padding: 14px;
  margin: 10px 0 18px;
  font-size: 16px;
}
button {
  background: #284739;
  color: white;
  border: none;
  border-radius: 6px;
}
</style>
</head>
<body>
<main>
<h1>Welham Nature Retreat</h1>
<h2>Record a Payment</h2>
<p>Only use this form after checking that the customer's bank transfer has arrived.</p>

<form method="POST" action="/api/mark-paid">
<label for="reference">Booking reference</label>
<input
  id="reference"
  name="reference"
  placeholder="WEL-XXXXXXXXXXXX"
  required
  autocomplete="off"
>

<label for="owner_password">Owner password</label>
<input
  id="owner_password"
  name="owner_password"
  type="password"
  required
  autocomplete="off"
>

<button type="submit">Mark as Paid</button>
</form>

<p>Payment confirmation emails are not yet enabled.</p>
</main>
</body>
</html>`);
}
