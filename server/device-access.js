function allowedSerials(user) {
  return new Set(Array.isArray(user.devices) ? user.devices : []);
}

function filterDevicesForUser(user, devices) {
  const allowed = allowedSerials(user);
  return devices.filter((device) => allowed.has(device.serial));
}

function assertDeviceAllowed(user, serial) {
  if (!serial || !allowedSerials(user).has(serial)) {
    const error = new Error('Device access denied.');
    error.status = 403;
    throw error;
  }
  return serial;
}

module.exports = { assertDeviceAllowed, filterDevicesForUser };
