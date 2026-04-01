/**
 * POST /api/order-feedback — optional email to café for low ratings; no DB writes.
 */

const express = require('express');
const nodemailer = require('nodemailer');

const GOOGLE_REVIEW_URL =
  'https://search.google.com/local/writereview?placeid=ChIJX2BkhKih2EcRPwV36PubVtA';

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

module.exports = function createFeedbackRouter() {
  const router = express.Router();

  router.post('/api/order-feedback', async (req, res) => {
    const body = req.body ?? {};
    const orderRaw = body.order_id;
    const rating = Number(body.rating);
    const comment = body.comment != null ? String(body.comment) : '';

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

    const shouldShowGooglePrompt = rating >= 4;

    if (rating <= 3) {
      sendNegativeFeedbackEmail({ orderIdStr, rating, comment }).catch((err) => {
        console.error('[order-feedback] send mail failed:', err.message || err);
      });
    }

    return res.json({
      ok: true,
      success: true,
      shouldShowGooglePrompt,
      googleReviewUrl: GOOGLE_REVIEW_URL,
    });
  });

  return router;
};
