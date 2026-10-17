// This private HTTP credential is deliberately independent of the public JS Maps key.
export function geocoderConfig() {
  const key = process.env.YANDEX_GEOCODER_API_KEY;
  const dailyLimit = Number(process.env.YANDEX_GEOCODER_DAILY_LIMIT);
  const timezone = process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE;
  if (!key || !Number.isSafeInteger(dailyLimit) || dailyLimit < 2 || !timezone)
    return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    return null;
  }
  const resetHour = Number(process.env.YANDEX_GEOCODER_QUOTA_RESET_HOUR || '0');
  if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23)
    return null;
  const cacheSeconds = Number(process.env.YANDEX_GEOCODER_CACHE_SECONDS || '0');
  if (
    !Number.isInteger(cacheSeconds) ||
    cacheSeconds < 0 ||
    cacheSeconds > 300
  )
    return null;
  let referer: string | undefined;
  const configuredReferer = process.env.YANDEX_GEOCODER_REFERER;
  if (configuredReferer) {
    try {
      // This comes only from server configuration, never the caller's
      // Referer header. Allow an HTTPS origin and an optional final slash;
      // reject credentials, paths and control characters before forwarding.
      if (
        !/^https:\/\//i.test(configuredReferer) ||
        /[\s\\?#@]/.test(configuredReferer)
      )
        return null;
      const url = new URL(configuredReferer);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        return null;
      referer = `${url.origin}/`;
    } catch {
      return null;
    }
  }
  return { key, dailyLimit, timezone, resetHour, cacheSeconds, referer };
}
export class GeocoderFailure extends Error {
  constructor(public readonly status: number = 0) {
    super('Geocoder unavailable');
  }
}
export async function reverseAddress(
  position: { lat: number; lng: number },
  key: string,
  referer?: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    apikey: key,
    geocode: `${position.lng},${position.lat}`,
    format: 'json',
    results: '1',
    lang: 'ru_RU',
  });
  const response = await fetch(
    `https://geocode-maps.yandex.ru/1.x/?${params}`,
    {
      signal: AbortSignal.timeout(4000),
      ...(referer ? { headers: { Referer: referer } } : {}),
    },
  );
  if (!response.ok) throw new GeocoderFailure(response.status);
  const body = await response.json();
  const components: { kind: string; name: string }[] =
    body?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject
      ?.metaDataProperty?.GeocoderMetaData?.Address?.Components || [];
  const street = components.find((part) => part.kind === 'street')?.name;
  const house = components.find((part) => part.kind === 'house')?.name;
  return street ? (house ? `${street}, ${house}` : street) : null;
}

export function quotaPeriod(
  now: Date,
  timezone: string,
  resetHour: number,
): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)!.value);
  const day = new Date(
    Date.UTC(
      part('year'),
      part('month') - 1,
      part('day') - (part('hour') < resetHour ? 1 : 0),
    ),
  );
  return day.toISOString().slice(0, 10);
}
