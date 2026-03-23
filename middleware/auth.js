const jwt = require('jsonwebtoken');

function getToken(req) {
  return (
    req.cookies?.session ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null)
  );
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired session' });
  }
}

function optionalAuth(req, res, next) {
  const token = getToken(req);
  if (!token) {
    req.userId = null;
    req.userEmail = null;
    return next();
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
  } catch {
    req.userId = null;
    req.userEmail = null;
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
