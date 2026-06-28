require('dotenv').config();

const { createApplication } = require('./web-application');
const { attachAuthenticatedWebSocket } = require('./websocket-auth');
const { startScheduler } = require('./scheduler-service');
const postgres = require('./postgres-state');
const queues = require('./queue-service');

const { app, server } = createApplication();
attachAuthenticatedWebSocket(server);
startScheduler();

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
let shuttingDown = false;

server.listen(port, host, () => {
  console.log(`Singh Cloud Emulator listening on http://${host}:${port}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully.`);
  const timeout = setTimeout(() => process.exit(1), 30_000);
  timeout.unref();
  server.close(async () => {
    await Promise.allSettled([postgres.close(), queues.close()]);
    clearTimeout(timeout);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
