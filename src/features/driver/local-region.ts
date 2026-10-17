import type { District } from "./model";

interface Position {
  lat: number;
  lng: number;
}

// Presentation only: off-shift GPS stays on this phone. Shift eligibility and
// persisted region assignment remain authoritative on the server.
export function localRegionAt(
  regions: readonly District[],
  point: Position,
): District | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  const matches = regions.filter((region) => {
    const ring = region.boundary?.[0];
    if (
      !Array.isArray(ring) ||
      ring.length < 3 ||
      !ring.every(
        (vertex) =>
          Array.isArray(vertex) &&
          vertex.length >= 2 &&
          Number.isFinite(vertex[0]) &&
          Number.isFinite(vertex[1]),
      )
    )
      return false;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [latI, lngI] = ring[i]!;
      const [latJ, lngJ] = ring[j]!;
      if (
        lngI > point.lng !== lngJ > point.lng &&
        point.lat < ((latJ - latI) * (point.lng - lngI)) / (lngJ - lngI) + latI
      )
        inside = !inside;
    }
    return inside;
  });
  if (matches.length < 2) return matches[0] ?? null;
  // Match the server's overlap rule: nearest centre among containing regions,
  // never nearest centre as a fallback outside all saved boundaries.
  const rad = Math.PI / 180;
  const distance = (region: District) => {
    const lat = Number(region.centerLat);
    const lng = Number(region.centerLng);
    const h =
      Math.sin(((lat - point.lat) * rad) / 2) ** 2 +
      Math.cos(point.lat * rad) *
        Math.cos(lat * rad) *
        Math.sin(((lng - point.lng) * rad) / 2) ** 2;
    return Number.isFinite(h) ? h : Infinity;
  };
  return matches.reduce((nearest, region) =>
    distance(region) < distance(nearest) ? region : nearest,
  );
}
