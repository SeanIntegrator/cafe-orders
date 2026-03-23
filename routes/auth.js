const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body ?? {};
    if (!credential) {
      return res.status(400).json({ error: 'Missing credential' });
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.JWT_SECRET) {
      console.error('Auth misconfigured: missing GOOGLE_CLIENT_ID or JWT_SECRET');
      return res.status(500).json({ error: 'Authentication not configured' });
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
      return res.status(400).json({ error: 'Invalid token payload' });
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

    return res.json({
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Google auth error:', error);
    if (
      error.message?.includes('Token used too late') ||
      error.message?.includes('Invalid token')
    ) {
      return res.status(401).json({ error: 'Invalid or expired Google credential' });
    }
    return res.status(500).json({ error: 'Authentication failed' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const token =
      req.cookies?.session ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'Authentication not configured' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await pool.query(
      'SELECT id, email, display_name, avatar_url FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = rows[0];
    return res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    console.error('Auth me error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('session', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
  return res.json({ success: true });
});

module.exports = router;
