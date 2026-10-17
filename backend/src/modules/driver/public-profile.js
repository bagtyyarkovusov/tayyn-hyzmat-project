// Installation identity stays internal to authenticated sessions and shift locks.
// Historical approval columns remain stored for migration safety only.
function publicDriverProfile(driver) {
  if (!driver) return driver;
  const { pushToken, currentDeviceId, currentDeviceLabel, pendingDeviceId,
    pendingDeviceLabel, pendingDeviceRequestedAt, shiftDeviceId, devices, ...profile } = driver;
  if (profile.user) profile.user = publicUserIdentity(profile.user);
  return profile;
}
function publicUserIdentity(user) {
  if (!user) return user;
  const { archivedPhone, ...identity } = user;
  return { ...identity, phone: archivedPhone || user.phone };
}
module.exports = { publicDriverProfile, publicUserIdentity };
