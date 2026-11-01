
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  return res.status(503).json({
    status: 'setup_pending',
    error: 'Online bookings are not yet enabled. Please contact Welham Nature Retreat.'
  });
}
