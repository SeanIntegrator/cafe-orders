require('dotenv').config();
const cors = require('cors');
const cookieParser = require('cookie-parser');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const createOrdersRouter = require('./routes/orders');
const createCatalogRouter = require('./routes/catalog');
const createCustomerOrdersRouter = require('./routes/customer-orders');
const createKdsHistoryRouter = require('./routes/kds-history');
const createFeedbackRouter = require('./routes/feedback');
const authRouter = require('./routes/auth');
const { createSquareWebhookHandler } = require('./routes/webhook');
const { startPolling } = require('./lib/orders-poller');
const { createCheckoutRouter, createWebhookHandler } = require('./routes/stripe');
const square = require('./lib/square');

const app = express();
app.set('trust proxy', 1);

/** Normalize to origin string exactly as browsers send (scheme + host, no path, no trailing slash). */
function normalizeCorsOrigin(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const extraOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => normalizeCorsOrigin(s))
  .filter(Boolean);
const allowedOrigins = [
  ...new Set(
    [
      ...extraOrigins,
      normalizeCorsOrigin(process.env.FRONTEND_URL),
      normalizeCorsOrigin('http://localhost:5173'),
      normalizeCorsOrigin('http://127.0.0.1:5173'),
    ].filter(Boolean)
  ),
];

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  },
  // Heartbeats help proxies / platforms (e.g. Railway) from treating the socket as idle
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  createWebhookHandler(io)
);
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  createSquareWebhookHandler(io)
);
app.use(express.json());

app.use('/api/auth', authRouter);
app.use(createOrdersRouter(io));
app.use(createCatalogRouter(io));
app.use(createCustomerOrdersRouter(io));
app.use(createKdsHistoryRouter(io));
app.use(createFeedbackRouter());
app.use('/api/stripe', createCheckoutRouter(io));

if (process.env.KDS_POLL_ENABLED !== 'false') {
  startPolling(io);
}

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Socket.io client connected:', socket.id);
  socket.on('disconnect', (reason) => {
    console.log('Socket.io client disconnected:', socket.id, 'reason:', reason);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port', PORT);
  console.log('Square API:', square.SQUARE_BASE_URL, `(env: ${square.SQUARE_ENV})`);
  if (allowedOrigins.length) {
    console.log('CORS allowed origins:', allowedOrigins.join(', '));
  }
});
