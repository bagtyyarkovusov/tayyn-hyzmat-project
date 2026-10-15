// Loads the Yandex Maps JS API v2.1 exactly once per page load and caches
// the resulting promise, so every component that needs `ymaps` (just the
// map screens now - reverse geocoding moved to services/geocoding.js, see
// the comment there for why) can just call loadYandexMaps() without
// worrying about double-injecting the <script> tag.
let loadPromise = null;

export function hasYandexMapsApiKey() {
  return Boolean(process.env.VUE_APP_YANDEX_MAPS_API_KEY);
}

export function loadYandexMaps() {
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    if (window.ymaps) {
      window.ymaps.ready(() => resolve(window.ymaps));
      return;
    }

    const params = new URLSearchParams({ lang: 'ru_RU' });
    const apiKey = process.env.VUE_APP_YANDEX_MAPS_API_KEY;
    if (apiKey) params.set('apikey', apiKey);

    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?${params.toString()}`;
    script.async = true;
    script.onload = () => {
      if (!window.ymaps) {
        loadPromise = null;
        reject(new Error('Yandex Maps API загрузился, но объект ymaps недоступен'));
        return;
      }
      window.ymaps.ready(() => resolve(window.ymaps));
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Не удалось загрузить Yandex Maps API'));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}
