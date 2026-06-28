const { WebSocketServer } = require('ws');
const auth = require('./auth');
const store = require('./platform-store');

let wss = null;
const rooms = new Map();

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function leaveRoom(socket) {
  if (!socket.sessionId) return;
  const room = rooms.get(socket.sessionId);
  if (room) {
    room.delete(socket);
    if (room.size === 0) rooms.delete(socket.sessionId);
  }
  socket.sessionId = null;
}

async function canJoin(user, sessionId) {
  const state = await store.readState();
  const session = state.sessions.find((item) => item.id === sessionId);
  return Boolean(session && (user.role === 'admin' || session.userId === user.id));
}

function relayToRoom(socket, payload) {
  const room = rooms.get(socket.sessionId);
  if (!room) return;
  for (const peer of room) {
    if (peer !== socket) send(peer, { ...payload, from: socket.peerId });
  }
}

function attachAuthenticatedWebSocket(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname !== '/ws') return socket.destroy();
      const expectedOrigin = process.env.PUBLIC_ORIGIN;
      if (expectedOrigin && request.headers.origin !== expectedOrigin) throw new Error('Origin rejected.');
      const user = auth.authenticateUpgrade(request);
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.userId = user.id;
        webSocket.user = user;
        webSocket.peerId = `${user.id}:${Math.random().toString(36).slice(2, 10)}`;
        webSocket.sessionId = null;
        wss.emit('connection', webSocket, request);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (socket) => {
    send(socket, { type: 'connected', peerId: socket.peerId, message: 'Authenticated WebSocket connected.' });

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString('utf8'));
        if (message.type === 'ping') return send(socket, { type: 'pong', at: Date.now() });

        if (message.type === 'join-session') {
          const sessionId = String(message.sessionId || '');
          if (!(await canJoin(socket.user, sessionId))) return send(socket, { type: 'error', message: 'Session access denied.' });
          leaveRoom(socket);
          socket.sessionId = sessionId;
          if (!rooms.has(sessionId)) rooms.set(sessionId, new Set());
          rooms.get(sessionId).add(socket);
          send(socket, { type: 'session-joined', sessionId, peerId: socket.peerId });
          relayToRoom(socket, { type: 'peer-joined', sessionId });
          return;
        }

        if (['webrtc-offer', 'webrtc-answer', 'ice-candidate', 'worker-event', 'terminal-output', 'build-output'].includes(message.type)) {
          if (!socket.sessionId) return send(socket, { type: 'error', message: 'Join a session first.' });
          const payload = { type: message.type, sessionId: socket.sessionId, data: message.data || null };
          relayToRoom(socket, payload);
        }
      } catch {
        send(socket, { type: 'error', message: 'Invalid WebSocket message.' });
      }
    });

    socket.on('close', () => {
      if (socket.sessionId) relayToRoom(socket, { type: 'peer-left', sessionId: socket.sessionId });
      leaveRoom(socket);
    });
  });

  return wss;
}

function sendToUser(userId, payload) {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.userId === userId) send(client, payload);
  }
}

function sendToSession(sessionId, payload) {
  const room = rooms.get(sessionId);
  if (!room) return;
  for (const client of room) send(client, payload);
}

module.exports = { attachAuthenticatedWebSocket, sendToSession, sendToUser };
