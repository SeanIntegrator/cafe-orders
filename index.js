require('dotenv').config();
const cors = require('cors');


const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ordersRouter = require('./routes/orders');
const catalogRouter = require('./routes/catalog');
const { attachWebhook } = require('./routes/webhook');
const square = require('./lib/square');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({
  origin: [
    'https://customer-app-production-99e9.up.railway.app',
    'http://localhost:5173'
  ]
}));

app.use(express.json());

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
