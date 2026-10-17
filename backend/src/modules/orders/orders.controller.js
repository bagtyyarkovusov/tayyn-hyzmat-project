const asyncHandler = require('../../utils/asyncHandler');
const service = require('./orders.service');

const available = asyncHandler(async (req, res) => {
  const orders = await service.listAvailable(req.driver, req.query.districtId, req.query.scope);
  res.json(orders);
});

const current = asyncHandler(async (req, res) => {
  const order = await service.getCurrent(req.driver);
  res.json(order);
});

const accept = asyncHandler(async (req, res) => {
  const order = await service.accept(req.body.orderId, req.driver, req.body.etaMinutes);
  res.json(order);
});

const waiting = asyncHandler(async (req, res) => {
  const order = await service.markWaiting(req.body.orderId, req.driver);
  res.json(order);
});

const start = asyncHandler(async (req, res) => {
  const order = await service.startTrip(req.body.orderId, req.driver);
  res.json(order);
});

const complete = asyncHandler(async (req, res) => {
  const order = await service.complete(req.body.orderId, req.driver);
  res.json(order);
});

const cancel = asyncHandler(async (req, res) => {
  const order = await service.cancel(req.body.orderId, req.driver, req.body.reason);
  res.json(order);
});

const acceptPrivateOffer = asyncHandler(async (req, res) => res.json(await service.accept(req.body.orderId, req.driver, req.body.etaMinutes, req.body.privateOfferExpiresAt)));
const privateOffer = asyncHandler(async (req, res) => res.json(await service.getPrivateOffer(req.driver)));
const declinePrivateOffer = asyncHandler(async (req, res) => res.json(await service.declinePrivateOffer(req.body.orderId, req.driver, req.body.privateOfferExpiresAt)));
module.exports = { acceptPrivateOffer, privateOffer, declinePrivateOffer, available, current, accept, waiting, start, complete, cancel };
