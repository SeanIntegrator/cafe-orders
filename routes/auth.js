const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Customer app (e.g. *.up.railway.app) and API (another *.up.railway.app) are cross-site.
 * SameSite=Lax cookies are not sent on credentialed fetch — use None+Secure in production.
 */
function sessionCookieOptions() {
  const prod = process.env.NODE_ENV === 'production';
  if (prod) {
    return { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 };
  }
  return { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 };
}

async function buildUserResponsePayload(userRow) {
  const { rows: cnt } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM orders WHERE user_id = $1',
    [userRow.id]
  );
  return {
    id: userRow.id,
    email: userRow.email,
    displayName: userRow.display_name,
    avatarUrl: userRow.avatar_url,
    createdAt: userRow.created_at ? new Date(userRow.created_at).toISOString() : null,
    orderCount: cnt[0]?.c ?? 0,
  };
}

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body ?? {};
    if (!credential) {
      return res.status(400).json({ ok: false, code: 'MISSING_CREDENTIAL', error: 'Missing credential' });
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.JWT_SECRET) {
      console.error('Auth misconfigured: missing GOOGLE_CLIENT_ID or JWT_SECRET');
      return res.status(500).json({ ok: false, code: 'AUTH_CONFIG', error: 'Authentication not configured' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const displayName = payload.name || email?.split('@')[0] || 'User';
    const avatarUrl = payload.picture || null;

    if (!googleId || !email) {
      return res.status(400).json({ ok: false, code: 'INVALID_GOOGLE_TOKEN', error: 'Invalid token payload' });
    }

    const upsertQuery = `
      INSERT INTO users (google_id, email, display_name, avatar_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (google_id)
      DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      RETURNING id, google_id, email, display_name, avatar_url, created_at
    `;

    const { rows } = await pool.query(upsertQuery, [
      googleId,
      email,
      displayName,
      avatarUrl,
    ]);
    const user = rows[0];

    const sessionToken = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    const payloadUser = await buildUserResponsePayload(user);

    return res.json({
      ok: true,
      token: sessionToken,
      user: payloadUser,
    });
  } catch (error) {
    console.error('Google auth error:', error);
    if (
      error.message?.includes('Token used too late') ||
      error.message?.includes('Invalid token')
    ) {
      return res.status(401).json({
        ok: false,
        code: 'INVALID_GOOGLE_CREDENTIAL',
        error: 'Invalid or expired Google credential',
      });
    }
    return res.status(500).json({ ok: false, code: 'AUTH_FAILED', error: 'Authentication failed' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const token =
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null) || req.cookies?.session;

    if (!token) {
      return res.json({ ok: true, user: null });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ ok: false, code: 'AUTH_CONFIG', error: 'Authentication not configured' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      'SELECT id, email, display_name, avatar_url, created_at FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ ok: false, code: 'USER_NOT_FOUND', error: 'User not found' });
    }

    const user = rows[0];
    const payloadUser = await buildUserResponsePayload(user);
    return res.json({ ok: true, user: payloadUser });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        ok: false,
        code: 'SESSION_INVALID',
        error: 'Invalid or expired session',
      });
    }
    console.error('Auth me error:', error);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  const o = sessionCookieOptions();
  res.clearCookie('session', {
    path: o.path,
    httpOnly: o.httpOnly,
    sameSite: o.sameSite,
    secure: o.secure,
  });
  return res.json({ ok: true, success: true });
});

module.exports = router;
