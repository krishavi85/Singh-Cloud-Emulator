require('dotenv').config();

const { createApplication } = require('./web-application');
const { attachAuthenticatedWebSocket } = require('./websocket-auth');

const { app, server } = createApplication();
attachAuthenticatedWebSocket(server);

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);

server.listen(port, host, () => {
  console.log(`Singh Cloud Emulator listening on http://${host}:${port}`);
});

module.exports = { app, server };
