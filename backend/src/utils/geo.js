const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two lat/lng points, in kilometers.
function haversineDistanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Nearest-center lookup: dispatch zones here are defined by a center point,
// not a surveyed polygon, so "which district is this point in" is answered
// as "which zone center is closest" (a Voronoi-style tiling of the city).
// `districts` items need { id, centerLat, centerLng } - Prisma Decimal
// fields are accepted directly, they coerce fine through Number().
function findNearestDistrict(districts, point) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const district of districts) {
    const distance = haversineDistanceKm(point, {
      lat: Number(district.centerLat),
      lng: Number(district.centerLng)
    });
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = district;
    }
  }

  return nearest ? { district: nearest, distanceKm: nearestDistance } : null;
}

// Standard ray-casting point-in-polygon test. `ring` is an array of
// [lat, lng] pairs (the outer boundary only - district boundaries drawn in
// the admin editor are simple polygons, no holes). Matches the
// [lat, lng] point order used everywhere else in this file/Yandex's own
// polygon geometry, NOT the [lng, lat] GeoJSON convention.
function pointInPolygonRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const intersects = lngI > point.lng !== lngJ > point.lng && point.lat < ((latJ - latI) * (point.lng - lngI)) / (lngJ - lngI) + latI;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A district's `boundary` is stored as an array of rings (currently always
// exactly one - the outer ring - but stored as an array so a hole could be
// added later without a schema change); a point is "in" the district if
// it's in the outer ring.
function pointInDistrictBoundary(point, boundary) {
  if (!Array.isArray(boundary) || boundary.length === 0) return false;
  return pointInPolygonRing(point, boundary[0]);
}

// Resolves which district a point belongs to, preferring a real drawn
// boundary (see the admin "Границы районов" editor) over the older
// nearest-center Voronoi guess - see districts.service.js#findNearestDistrictForPoint
// for how the two are combined, and why nearest-center is kept as a
// fallback rather than replaced outright (not every district has a drawn
// boundary yet, and a point genuinely outside every polygon - e.g. well
// outside the city - still needs *some* answer).
function findDistrictByBoundary(districts, point) {
  const matches = districts.filter((d) => pointInDistrictBoundary(point, d.boundary));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Overlapping polygons shouldn't normally happen, but could transiently
  // during editing - break the tie the same way as everywhere else, by
  // nearest center.
  return findNearestDistrict(matches, point).district;
}

module.exports = { haversineDistanceKm, findNearestDistrict, findDistrictByBoundary };
