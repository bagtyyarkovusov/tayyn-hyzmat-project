const asyncHandler = require('../../utils/asyncHandler');
const service = require('./driver.service');

const profile = asyncHandler(async (req, res) => {
  const driver = await service.getProfile(req.driver.id);
  res.json(driver);
});

const balance = asyncHandler(async (req, res) => {
  const balance = await service.getBalance(req.driver.userId);
  res.json(balance);
});

const postLocation = asyncHandler(async (req, res) => {
  const updated = await service.updateLocation(req.driver, req.body);
  res.json({
    driverId: updated.id,
    lat: updated.lastLat,
    lng: updated.lastLng,
    recordedAt: updated.lastLocationAt,
    // Was missing entirely - the frontend's driverAuth.driver.districtId
    // otherwise never learns about a GPS-driven district change and goes
    // stale the moment a driver physically moves after login (see
    // locationReporter.js#flushLocationQueue, which now reads this).
    districtId: updated.districtId
  });
});

const postStatus = asyncHandler(async (req, res) => {
  const updated = await service.setStatus(req.driver, req.body);
  res.json({ driverId: updated.id, isOnline: updated.isOnline, isAvailable: updated.isAvailable });
});

const postDistrict = asyncHandler(async (req, res) => {
  const updated = await service.setDistrict(req.driver, req.body.districtId);
  res.json(updated);
});

const getHistory = asyncHandler(async (req, res) => {
  const result = await service.getHistory(req.driver, req.query);
  res.json(result);
});

const getMessages = asyncHandler(async (req, res) => {
  const result = await service.getMessages(req.driver, req.query);
  res.json(result);
});

const postMessagesRead = asyncHandler(async (req, res) => {
  await service.markChatRead(req.driver);
  res.status(204).send();
});

const postMessage = asyncHandler(async (req, res) => {
  const message = await service.sendMessage(req.driver, req.body.body);
  res.status(201).json(message);
});

const postPushToken = asyncHandler(async (req, res) => {
  await service.savePushToken(req.driver, req.body.token);
  res.status(204).send();
});

module.exports = {
  profile,
  balance,
  postLocation,
  postStatus,
  postDistrict,
  getHistory,
  getMessages,
  postMessagesRead,
  postMessage,
  postPushToken
};
