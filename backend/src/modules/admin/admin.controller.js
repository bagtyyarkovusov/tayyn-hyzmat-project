const asyncHandler = require('../../utils/asyncHandler');
const service = require('./admin.service');
const ordersService = require('../orders/orders.service');

const createDriver = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createDriver(req.body, req.user.id));
});

const listDrivers = asyncHandler(async (req, res) => {
  const result = await service.listDrivers(req.query);
  res.json(result);
});

const getDriver = asyncHandler(async (req, res) => {
  const driver = await service.getDriver(req.params.id);
  res.json(require('../driver/public-profile').publicDriverProfile(driver));
});

const blockDriver = asyncHandler(async (req, res) => {
  const driver = await service.blockDriver(req.params.id, req.user.id, req.body.reason);
  res.json(require('../driver/public-profile').publicDriverProfile(driver));
});

const unblockDriver = asyncHandler(async (req, res) => {
  const driver = await service.unblockDriver(req.params.id, req.user.id);
  res.json(require('../driver/public-profile').publicDriverProfile(driver));
});

const signOutEverywhere = asyncHandler(async (req, res) => {
  res.json(await service.signOutEverywhere(req.params.id, req.user.id));
});

const adjustBalance = asyncHandler(async (req, res) => {
  const result = await service.adjustBalance(req.params.id, req.body, req.user.id);
  res.json(result);
});

const history = asyncHandler(async (req, res) => {
  const result = await service.getHistory(req.params.id, req.query);
  res.json(result);
});

const sendMessage = asyncHandler(async (req, res) => {
  const result = await service.sendMessage(req.body, req.user.id);
  res.json(result);
});

const createOrder = asyncHandler(async (req, res) => {
  const order = await ordersService.createOrder(req.body);
  res.status(201).json(order);
});

const listOrders = asyncHandler(async (req, res) => {
  const result = await service.listOrders(req.query);
  res.json(result);
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await ordersService.adminCancel(req.params.id, req.body.outcome, req.user.id);
  res.json(order);
});

const forceResolveOrder = asyncHandler(async (req, res) => {
  const order = await ordersService.forceResolveStarted(req.params.id, req.user.id, req.body.reason);
  res.json(order);
});

const activity = asyncHandler(async (req, res) => {
  const events = await service.getActivity({ limit: req.query.limit });
  res.json({ items: events });
});

const driverMessages = asyncHandler(async (req, res) => {
  const result = await service.getDriverMessages(req.params.id, req.query);
  res.json(result);
});

const deleteDriver = asyncHandler(async (req, res) => {
  await service.deleteDriver(req.params.id, req.user.id);
  res.status(204).end();
});

const markMessagesRead = asyncHandler(async (req, res) => {
  await service.markMessagesRead(req.params.id, req.body.throughMessageId);
  res.status(204).end();
});

const unreadDriverIds = asyncHandler(async (req, res) => {
  res.json(await service.listUnreadMessages());
});

const updateVehicle = asyncHandler(async (req, res) => {
  const vehicle = await service.updateVehicle(req.params.id, req.body);
  res.json(vehicle);
});

const listDistricts = asyncHandler(async (req, res) => {
  const districts = await service.listDistricts();
  res.json(districts);
});

const updateDistrictBoundary = asyncHandler(async (req, res) => {
  const district = await service.updateDistrictBoundary(req.params.id, req.body.boundary);
  res.json(district);
});

const privateOffer = asyncHandler(async (req, res) => res.json(await ordersService.offerPrivately(req.params.id, req.body.driverId, req.body.broadcastAfterPrivateExpiry)));
module.exports = {
  privateOffer,
  createDriver,
  listDrivers,
  getDriver,
  blockDriver,
  unblockDriver,
  signOutEverywhere,
  adjustBalance,
  history,
  sendMessage,
  createOrder,
  listOrders,
  cancelOrder,
  forceResolveOrder,
  activity,
  driverMessages,
  updateVehicle,
  listDistricts,
  updateDistrictBoundary,
  markMessagesRead,
  unreadDriverIds,
  deleteDriver
};
