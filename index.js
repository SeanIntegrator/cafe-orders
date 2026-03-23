require('dotenv').config();
const cors = require('cors');
const cookieParser = require('cookie-parser');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ordersRouter = require('./routes/orders');
const catalogRouter = require('./routes/catalog');
const authRouter = require('./routes/auth');
const { attachWebhook } = require('./routes/webhook');
const square = require('./lib/square');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://customer-app-production-99e9.up.railway.app',
  'http://localhost:5173',
].filter(Boolean);

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
app.use(catalogRouter);
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
