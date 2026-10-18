// Exact identity is shared by legacy offer sockets and the durable coordinator.
function notificationEventId(order) {
  return `${order.offerAttemptKind || (order.privateOfferDriverId ? 'private' : 'order')}:${order.id}:${order.offerAttemptId}`;
}
function orderPayload(order) {
  if (!order) return order;
  return { ...order, serverTime: new Date().toISOString(), expiresAt: order.privateOfferExpiresAt ?? order.publicRegionOnlyUntil ?? null, notificationEventId: notificationEventId(order), resolutionActions: order.cancellationReviewRequired ? ['REOFFER', 'FINAL_CANCEL'] : [] };
}
function invalidation(order) {
  return { orderId: order.id, offerAttemptId: order.offerAttemptId, notificationEventId: notificationEventId(order), eventId: notificationEventId(order), privateOfferExpiresAt: order.privateOfferExpiresAt };
}
function publicOfferPayload(order) {
  const keys = ['id', 'orderNumber', 'offerAttemptId', 'offerAttemptKind', 'pickupLat', 'pickupLng', 'pickupAddress', 'dropoffLat', 'dropoffLng', 'dropoffAddress', 'priceEstimated', 'districtId', 'district', 'createdAt', 'note', 'publicReleasedGloballyAt', 'publicRegionOnlyUntil', 'privateOfferExpiresAt'];
  return orderPayload(Object.fromEntries(keys.map(key => [key, order[key]])));
}
module.exports = { notificationEventId, orderPayload, invalidation, publicOfferPayload };
