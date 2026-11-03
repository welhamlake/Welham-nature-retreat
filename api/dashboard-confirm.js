
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const body = typeof req.body === 'string'
    ? Object.fromEntries(new URLSearchParams(req.body))
    : req.body || {};

  const { reference, decision } = body;

  if (typeof reference !== 'string' ||
      !/^WEL-[A-Z0-9]+$/.test(reference) ||
      !['approve', 'decline'].includes(decision)) {
    return res.status(400).send('Invalid booking request.');
  }

  const action = decision === 'approve' ? 'Approve' : 'Decline';

  return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Confirm ${action} | Welham</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f5f1;color:#243328;font:16px Arial,sans-serif}
header{background:#234735;color:white;padding:22px 16px}
main{max-width:500px;margin:25px auto;padding:18px}
.card{background:white;border-radius:12px;padding:22px}
input,button{font:inherit;padding:14px;width:100%;border-radius:8px;margin:10px 0}
input{border:1px solid #aaa}
button{background:#234735;color:white;border:0;font-weight:bold}
button.decline{background:#8b3f35}
a{color:#234735}
</style>
</head>
<body>
<header>
<h1>Welham Nature Retreat</h1>
<p>Booking Management</p>
</header>
<main>
<div class="card">
<h2>Confirm ${action}</h2>
<p><strong>Booking:</strong> ${escapeHtml(reference)}</p>
<p>Are you sure you want to ${action.toLowerCase()} this booking?</p>

<form method="POST" action="/api/dashboard-action">
<input type="hidden" name="reference" value="${escapeHtml(reference)}">
<input type="hidden" name="decision" value="${escapeHtml(decision)}">

<label for="owner_password">Owner password</label>
<input id="owner_password"
       type="password"
       name="owner_password"
       autocomplete="off"
       required>

<button type="submit" class="${decision === 'decline' ? 'decline' : ''}">
Yes, ${action} Booking
</button>
</form>

<p><a href="/api/dashboard">Cancel and return to dashboard</a></p>
</div>
</main>
</body>
</html>`);
}
