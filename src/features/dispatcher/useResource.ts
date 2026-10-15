import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import { adminSession } from "@/features/auth/session";
import { errorMessage } from "@/shared/api";
export function useResource<T>(
  fetcher: () => Promise<T>,
  initial: T,
  events: string[] = [],
) {
  const data = shallowRef<T>(initial);
  const loading = ref(true);
  const error = ref("");
  let version = 0;
  let alive = true;
  async function load() {
    const request = ++version;
    loading.value = true;
    error.value = "";
    try {
      const result = await fetcher();
      if (alive && request === version) data.value = result;
    } catch (cause) {
      if (alive && request === version) error.value = errorMessage(cause);
    } finally {
      if (alive && request === version) loading.value = false;
    }
  }
  const off: (() => void)[] = [];
  onMounted(() => {
    void load();
    events.forEach((event) =>
      off.push(
        adminSession.on(event, () => {
          void load();
        }),
      ),
    );
  });
  onUnmounted(() => {
    alive = false;
    off.forEach((stop) => stop());
  });
  return { data, loading, error, load };
}
