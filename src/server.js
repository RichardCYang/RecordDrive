import process from 'node:process';
import { createApplication } from './app.js';
import { startNetworkServers } from './network-server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function startRecordDrive() {
  console.log(`RecordDrive is starting (PID ${process.pid}, working directory: ${process.cwd()}).`);

  const app = createApplication();
  const runtimeControl = await startNetworkServers(app);
  console.log('RecordDrive startup completed.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`RecordDrive received ${signal}; shutting down.`);

    const forceExitTimer = setTimeout(() => {
      console.error('RecordDrive shutdown timed out; forcing process exit.');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      await runtimeControl.close?.();
      app.recorddrive.smbService?.close?.();
      app.recorddrive.db?.close?.();
      clearTimeout(forceExitTimer);
      console.log('RecordDrive shutdown completed.');
      process.exitCode = 0;
    } catch (error) {
      console.error('RecordDrive failed to shut down cleanly:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

startRecordDrive().catch((error) => {
  console.error('RecordDrive failed to start:', error);
  process.exit(1);
});
