function startEmulator() {
  throw new Error('Start the Android Virtual Device from Android Studio Device Manager, then refresh the device list.');
}

async function stopEmulator() {
  return false;
}

function managedStatus() {
  return {
    running: false,
    pid: null,
    mode: 'external'
  };
}

module.exports = { managedStatus, startEmulator, stopEmulator };
