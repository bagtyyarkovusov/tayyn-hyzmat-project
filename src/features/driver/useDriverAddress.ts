import { onUnmounted, ref, watch } from "vue";
import {
  hasYandexMapsApiKey,
  reverseYandexAddress,
} from "@/shared/maps/yandex";

interface Position {
  lat: number;
  lng: number;
}

// GPS and region eligibility are independent of this optional vendor lookup.
// Coordinates remain visible when the provider is offline or not authorised.
export function useDriverAddress(
  position: () => Position | null,
  account: () => string | undefined,
) {
  const address = ref("");
  let generation = 0;
  let lastLookupAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, string>();
  const stop = watch(
    () => [position()?.lat, position()?.lng, account()] as const,
    ([lat, lng, identity], previous) => {
      const current = ++generation;
      clearTimeout(timer);
      address.value = "";
      if (identity !== previous?.[2]) {
        cache.clear();
        lastLookupAt = 0;
      }
      if (lat == null || lng == null || !identity || !hasYandexMapsApiKey())
        return;
      // Roughly 10-metre cells keep stationary GPS jitter off the provider.
      const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
      if (cache.has(key)) {
        address.value = cache.get(key)!;
        return;
      }
      timer = setTimeout(
        async () => {
          lastLookupAt = Date.now();
          try {
            const resolved = await reverseYandexAddress(lat, lng);
            if (generation !== current) return;
            if (resolved) {
              if (cache.size >= 32) cache.delete(cache.keys().next().value!);
              cache.set(key, resolved);
              address.value = resolved;
            }
          } catch {
            // Never replace an actual GPS position with a guessed place name.
          }
        },
        Math.max(0, lastLookupAt + 30_000 - Date.now()),
      );
    },
    { immediate: true },
  );
  onUnmounted(() => {
    ++generation;
    clearTimeout(timer);
    stop();
  });
  return address;
}
