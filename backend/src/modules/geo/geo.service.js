const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');

// Reverse geocoding (coordinates -> a human address like "Гёроглы köçesi,
// 38") via OpenStreetMap's public Nominatim service, called server-side.
//
// This started as a direct client-side call to Yandex's HTTP Geocoder API,
// then a direct client-side call to Nominatim - both abandoned. Yandex was
// abandoned because Yandex Cloud's billing signup only supports Russia and
// Kazakhstan as a region, so an Ashgabat-based account can never create the
// billing account that product requires (confirmed via direct curl tests:
// the console showed the "API Геокодера" product as "Активен" while every
// real request came back `403 Invalid api key`, while the JS Maps API -
// which doesn't need cloud billing - worked fine on the same key). Calling
// Nominatim directly from the browser was abandoned next: its public
// endpoint doesn't reliably send back `Access-Control-Allow-Origin` (it
// sits behind a Varnish cache whose `Vary` header doesn't include `Origin`,
// so a cached response for one caller can get served to another with the
// CORS header stripped) - fetch() from the app's own origin would silently
// fail unpredictably. Routing it through our own backend sidesteps CORS
// entirely (same-origin from the frontend's point of view) and lets us send
// the identifying User-Agent Nominatim's usage policy actually asks
// server-side callers to send.
//
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
// max ~1 request/second against the public instance. Callers on the
// frontend already throttle themselves well beyond that (GpsInfoCard.vue's
// GEOCODE_MIN_INTERVAL_MS) - this is a shared public service, not a
// per-project quota, so if usage ever grows enough to matter, this is the
// one place to swap in a paid/dedicated geocoder.
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'TayynHyzmat/1.0 (+https://taxi.atajan.org; taxi dispatch app reverse geocoding)';

async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '18',
    'accept-language': 'ru'
  });

  let response;
  try {
    response = await fetch(`${NOMINATIM_REVERSE_URL}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT }
    });
  } catch (err) {
    logger.warn({ err }, 'Nominatim reverse geocode request failed');
    throw ApiError.badRequest('Не удалось определить адрес');
  }

  if (!response.ok) {
    logger.warn({ status: response.status }, 'Nominatim reverse geocode returned non-OK status');
    throw ApiError.badRequest('Не удалось определить адрес');
  }

  const data = await response.json();
  return { address: formatAddress(data) };
}

function formatAddress(data) {
  if (!data) return null;
  const a = data.address || {};
  const street = a.road || a.pedestrian || a.footway || a.street;
  const house = a.house_number;
  const area = a.suburb || a.city_district || a.neighbourhood;
  const parts = [];
  if (street) parts.push(house ? `${street}, ${house}` : street);
  else if (area) parts.push(area);
  if (parts.length === 0) return data.display_name || null;
  return parts.join(', ');
}

module.exports = { reverseGeocode };
