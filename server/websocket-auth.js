const { WebSocketServer } = require('ws');
const auth = require('./auth');

let wss = null;

function attachAuthenticatedWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname !== '/ws') return socket.destroy();
      const expectedOrigin = process.env.PUBLIC_ORIGIN;
      if (expectedOrigin && request.headers.origin !== expectedOrigin) throw new Error('Origin rejected.');
      const user = auth.authenticateUpgrade(request);
      wss.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.userId = user.id;
        wss.emit('connection', webSocket, request);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', message: 'Authenticated WebSocket connected.' }));
  });

  return wss;
}

function sendToUser(userId, payload) {
  if (!wss) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.userId === userId) client.send(message);
  }
}

module.exports = { attachAuthenticatedWebSocket, sendToUser };
