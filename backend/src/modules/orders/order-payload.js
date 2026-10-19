// Exact identity is shared by legacy offer sockets and the durable coordinator.
function notificationEventId(order) {
  return `${order.offerAttemptKind || (order.privateOfferDriverId ? 'private' : 'order')}:${order.id}:${order.offerAttemptId}`;
}
// Old cancelled rows have no recorded financial result. Label them UNKNOWN
// on read; the database never stores an inferred outcome.
function withCancellationOutcome(order) {
  return { ...order, cancellationOutcome: order.cancellationOutcome ?? (order.status === 'CANCELLED' ? 'UNKNOWN' : null) };
}
function orderPayload(order) {
  if (!order) return order;
  return { ...withCancellationOutcome(order), cancellationReviewRequired: false, serverTime: new Date().toISOString(), expiresAt: order.privateOfferExpiresAt ?? order.publicRegionOnlyUntil ?? null, notificationEventId: notificationEventId(order), resolutionActions: [] };
}
// Closed orders sent to drivers omit customer contact and the dispatcher's user id.
function driverClosedOrderPayload(order) {
  const { clientPhone: _clientPhone, cancelledBy: _cancelledBy, ...visible } = order;
  return visible;
}
function invalidation(order) {
  return { orderId: order.id, offerAttemptId: order.offerAttemptId, notificationEventId: notificationEventId(order), eventId: notificationEventId(order), privateOfferExpiresAt: order.privateOfferExpiresAt };
}
function publicOfferPayload(order) {
  const keys = ['id', 'orderNumber', 'offerAttemptId', 'offerAttemptKind', 'pickupLat', 'pickupLng', 'pickupAddress', 'dropoffLat', 'dropoffLng', 'dropoffAddress', 'priceEstimated', 'districtId', 'district', 'createdAt', 'note', 'publicReleasedGloballyAt', 'publicRegionOnlyUntil', 'privateOfferExpiresAt'];
  return orderPayload(Object.fromEntries(keys.map(key => [key, order[key]])));
}
module.exports = { notificationEventId, withCancellationOutcome, orderPayload, driverClosedOrderPayload, invalidation, publicOfferPayload };
