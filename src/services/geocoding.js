import apiClient from './apiClient';

// Reverse geocoding (coordinates -> a human address line like "Гёроглы
// köçesi, 38") via our own backend's /geo/reverse proxy (see backend
// src/modules/geo/geo.service.js for the full history of why this isn't a
// direct client-side call to Yandex or to Nominatim - short version: Yandex
// Cloud billing is region-locked to Russia/Kazakhstan, and Nominatim's
// public endpoint doesn't reliably send CORS headers back to a browser).
//
// Callers pass their own axios instance (driver's apiClient vs admin's
// adminApiClient) since this is used from both panels and each has its own
// token storage / 401-refresh behavior - see services/apiClient.js vs
// services/adminApiClient.js.
export async function reverseGeocode(lat, lng, client = apiClient) {
  const { data } = await client.get('/geo/reverse', { params: { lat, lng } });
  return data.address;
}
