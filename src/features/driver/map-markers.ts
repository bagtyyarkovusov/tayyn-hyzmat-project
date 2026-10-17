import type { Order } from "./model";

export type CoordinatePair = { lat: number; lng: number };

export function validCoordinatePair(
  lat: unknown,
  lng: unknown,
): CoordinatePair | null {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)
    return null;
  // 0,0 is a common fallback/sentinel, never a meaningful Turkmenistan point.
  if (latitude === 0 && longitude === 0) return null;
  return { lat: latitude, lng: longitude };
}

export function tripMarkerPoints(order: Order | null) {
  if (!order) return { pickup: null, destination: null };
  return {
    pickup: validCoordinatePair(order.pickupLat, order.pickupLng),
    destination: validCoordinatePair(order.dropoffLat, order.dropoffLng),
  };
}
