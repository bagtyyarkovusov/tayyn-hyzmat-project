// The vendor's dynamic objects stay at this adapter; saved rings remain [latitude, longitude].
let pending: Promise<any> | undefined;
export const hasYandexMapsApiKey = () =>
  Boolean(
    import.meta.env.VITE_YANDEX_MAPS_API_KEY ||
    import.meta.env.VUE_APP_YANDEX_MAPS_API_KEY,
  );
export function loadYandexMaps(): Promise<any> {
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const ready = () => {
      const maps = (window as any).ymaps;
      if (!maps) {
        pending = undefined;
        reject(new Error("Карта недоступна. Повторите попытку."));
        return;
      }
      maps.ready(() => resolve(maps));
    };
    if ((window as any).ymaps) return ready();
    if (!hasYandexMapsApiKey()) {
      pending = undefined;
      reject(
        new Error(
          "Ключ Яндекс Карт не настроен. Список регионов доступен без карты.",
        ),
      );
      return;
    }
    const script = document.createElement("script");
    const query = new URLSearchParams({
      lang: "ru_RU",
      apikey:
        import.meta.env.VITE_YANDEX_MAPS_API_KEY ||
        import.meta.env.VUE_APP_YANDEX_MAPS_API_KEY,
    });
    script.src = `https://api-maps.yandex.ru/2.1/?${query}`;
    script.async = true;
    script.onload = ready;
    script.onerror = () => {
      pending = undefined;
      script.remove();
      reject(new Error("Не удалось загрузить карту. Проверьте соединение."));
    };
    document.head.appendChild(script);
  });
  return pending;
}

// Yandex JS API accepts [latitude, longitude], unlike HTTP Geocoder's
// longitude,latitude string. Administrative names never define dispatch regions.
export async function reverseYandexAddress(
  lat: number,
  lng: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const maps = await loadYandexMaps();
        const result = await maps.geocode([lat, lng], { results: 1 });
        const place = result.geoObjects.get(0);
        if (!place) return null;
        const street = place.getThoroughfare();
        const house = place.getPremiseNumber();
        return street
          ? house
            ? `${street}, ${house}`
            : street
          : place.getAddressLine() || null;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Адрес недоступен")), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
