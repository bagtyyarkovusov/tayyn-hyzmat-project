import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDistrictByBoundary, findNearestDistrict, haversineDistanceKm } from '../src/utils/geo';

const districts = [
  { id: 'west', centerLat: '37.96', centerLng: '58.32', boundary: [[[37.94, 58.30], [37.98, 58.30], [37.98, 58.36], [37.94, 58.36]]] },
  { id: 'east', centerLat: '37.96', centerLng: '58.42', boundary: null }
];

test('a pickup inside a saved polygon belongs to that region', () => {
  assert.equal(findDistrictByBoundary(districts, { lat: 37.96, lng: 58.34 })?.id, 'west');
});

test('a pickup outside saved polygons has no polygon match but can use the nearest center', () => {
  const point = { lat: 37.96, lng: 58.43 };
  assert.equal(findDistrictByBoundary(districts, point), null);
  assert.equal(findNearestDistrict(districts, point)?.district.id, 'east');
});

test('overlapping regions resolve to the nearest center', () => {
  const overlap = [districts[0], { ...districts[1], centerLng: '58.35', boundary: districts[0].boundary }];
  assert.equal(findDistrictByBoundary(overlap, { lat: 37.96, lng: 58.349 })?.id, 'east');
});

test('no configured regions gives no assignment', () => {
  assert.equal(findDistrictByBoundary([], { lat: 37.96, lng: 58.32 }), null);
  assert.equal(findNearestDistrict([], { lat: 37.96, lng: 58.32 }), null);
});

test('one degree along the equator is approximately 111.195 kilometers', () => {
  assert.ok(Math.abs(haversineDistanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.195) < 0.001);
});
