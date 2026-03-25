require('dotenv').config();
const cors = require('cors');
const cookieParser = require('cookie-parser');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ordersRouter = require('./routes/orders');
const createCatalogRouter = require('./routes/catalog');
const createCustomerOrdersRouter = require('./routes/customer-orders');
const createKdsHistoryRouter = require('./routes/kds-history');
const authRouter = require('./routes/auth');
const { attachWebhook } = require('./routes/webhook');
const square = require('./lib/square');

const app = express();
app.set('trust proxy', 1);

const extraOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...extraOrigins, process.env.FRONTEND_URL, 'http://localhost:5173'].filter(Boolean))];

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  },
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
app.use(express.json());

app.use('/api/auth', authRouter);
app.use(ordersRouter);
app.use(createCatalogRouter(io));
app.use(createCustomerOrdersRouter(io));
app.use(createKdsHistoryRouter());
attachWebhook(app, io);

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
});
