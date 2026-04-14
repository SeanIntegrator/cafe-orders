/**
 * POST /api/order-feedback — authenticated; persists internal rating/comment to Postgres.
 * Google review URL is returned for a separate client step (not gated by rating).
 */

const express = require('express');
const nodemailer = require('nodemailer');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { fetchOrderRowForUser } = require('../lib/orders-db');

const GOOGLE_REVIEW_URL =
  'https://search.google.com/local/writereview?placeid=ChIJX2BkhKih2EcRPwV36PubVtA';

const MAX_COMMENT_LEN = 2000;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(String(process.env.SMTP_PORT), 10) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: port === 465,
    auth: { user, pass },
  });
  return transporter;
}

function sendNegativeFeedbackEmail({ orderIdStr, rating, comment }) {
  const to = process.env.CAFE_EMAIL || 'sean.stanfield42@gmail.com';
  const tail = orderIdStr.slice(-6);
  const subject = `⚠️ Customer feedback: ${rating}★ - Order #${tail}`;
  const text = `Customer gave ${rating}★

Comment:
${comment && String(comment).trim() ? String(comment).trim() : 'No comment provided'}

Order ID: ${orderIdStr}
Submitted: ${new Date().toISOString()}
`;

  const tx = getTransporter();
  if (!tx) {
    console.warn(
      '[order-feedback] SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS); email not sent.'
    );
    return Promise.resolve();
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  return tx.sendMail({
    from,
    to,
    subject,
    text,
  });
}

function normalizeComment(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  return s.length > MAX_COMMENT_LEN ? s.slice(0, MAX_COMMENT_LEN) : s;
}

module.exports = function createFeedbackRouter() {
  const router = express.Router();

  router.post('/api/order-feedback', requireAuth, async (req, res) => {
    const body = req.body ?? {};
    const orderRaw = body.order_id;
    const rating = Number(body.rating);
    const comment = normalizeComment(body.comment);

    const orderIdStr =
      orderRaw === undefined || orderRaw === null ? '' : String(orderRaw).trim();

    if (!orderIdStr) {
      return res
        .status(400)
        .json({ ok: false, success: false, code: 'ORDER_ID_REQUIRED', error: 'order_id required' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        ok: false,
        success: false,
        code: 'INVALID_RATING',
        error: 'rating must be an integer 1–5',
      });
    }

    const orderId = parseInt(orderIdStr, 10);
    if (!Number.isFinite(orderId) || orderId < 1) {
      return res.status(400).json({
        ok: false,
        success: false,
        code: 'INVALID_ORDER_ID',
        error: 'order_id must be a positive integer',
      });
    }

    const order = await fetchOrderRowForUser(orderId, req.userId);
    if (!order) {
      return res.status(404).json({
        ok: false,
        success: false,
        code: 'ORDER_NOT_FOUND',
        error: 'Order not found',
      });
    }

    try {
      await pool.query(
        `INSERT INTO order_feedback (order_id, user_id, rating, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_id) DO UPDATE SET
           rating = EXCLUDED.rating,
           comment = EXCLUDED.comment,
           user_id = EXCLUDED.user_id`,
        [orderId, req.userId, rating, comment === '' ? null : comment]
      );
    } catch (err) {
      console.error('[order-feedback] DB insert failed:', err.message || err);
      return res.status(500).json({
        ok: false,
        success: false,
        code: 'FEEDBACK_SAVE_FAILED',
        error: 'Could not save feedback',
      });
    }

    if (rating <= 3) {
      sendNegativeFeedbackEmail({ orderIdStr, rating, comment }).catch((err) => {
        console.error('[order-feedback] send mail failed:', err.message || err);
      });
    }

    return res.json({
      ok: true,
      success: true,
      googleReviewUrl: GOOGLE_REVIEW_URL,
    });
  });

  return router;
};
