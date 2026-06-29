function allowedSerials(user) {
  return new Set(Array.isArray(user.devices) ? user.devices : []);
}

function hasAllDevices(user) {
  return allowedSerials(user).has('*');
}

function filterDevicesForUser(user, devices) {
  if (hasAllDevices(user)) return devices;
  const allowed = allowedSerials(user);
  return devices.filter((device) => allowed.has(device.serial));
}

function assertDeviceAllowed(user, serial) {
  if (!serial || (!hasAllDevices(user) && !allowedSerials(user).has(serial))) {
    const error = new Error('Device access denied.');
    error.status = 403;
    throw error;
  }
  return serial;
}

module.exports = { assertDeviceAllowed, filterDevicesForUser };
