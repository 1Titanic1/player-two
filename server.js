/* ВТОРОЙ ИГРОК - сигнальный сервер.
   Только знакомит устройства: видео через него НЕ идёт. */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 60000, maxHttpBufferSize: 1e7 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() }));

const rooms = new Map(); // code -> Map(socketId -> { mic, sharing })

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', (cb) => {
    const code = genCode();
    currentRoom = code;
    rooms.set(code, new Map([[socket.id, { mic: true, sharing: false }]]));
    socket.join(code);
    console.log('[+] Комната ' + code + ' создана');
    cb({ ok: true, code });
  });

  socket.on('join-room', (code, cb) => {
    code = String(code).toUpperCase().trim();
    if (!rooms.has(code)) return cb({ ok: false, error: 'Комната не найдена. Проверь код.' });
    const room = rooms.get(code);
    if (room.size >= 2) return cb({ ok: false, error: 'В комнате уже два человека.' });
    currentRoom = code;
    room.set(socket.id, { mic: true, sharing: false });
    socket.join(code);
    cb({ ok: true, code });
    socket.to(code).emit('peer-joined', socket.id);
    io.to(code).emit('room-state', Array.from(room.entries()));
    console.log('[+] Гость зашёл в ' + code);
  });

  socket.on('rtc-signal', (code, targetId, payload) => {
    io.to(targetId).emit('rtc-signal', socket.id, payload);
  });

  socket.on('state-update', (code, state) => {
    if (!rooms.has(code)) return;
    rooms.get(code).set(socket.id, state);
    socket.to(code).emit('peer-state', socket.id, state);
  });

  socket.on('need-restart', (code) => {
    socket.to(code).emit('peer-restart', socket.id);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    rooms.get(currentRoom).delete(socket.id);
    if (rooms.get(currentRoom).size === 0) {
      rooms.delete(currentRoom);
      console.log('[-] Комната ' + currentRoom + ' закрыта');
    } else {
      socket.to(currentRoom).emit('peer-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
