import { onMounted, onUnmounted } from "vue";

/** Reconcile persisted messages when socket delivery was suspended or missed. */
export function useChatRecovery(recover: () => void) {
  function resume() {
    if (!document.hidden && navigator.onLine) recover();
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("native:notification", resume);
    // Foreground HTTP recovery remains available if the native shift is alive
    // while the WebView socket has silently stopped receiving messages.
    timer = setInterval(resume, 30_000);
  });
  onUnmounted(() => {
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("focus", resume);
    window.removeEventListener("native:notification", resume);
    clearInterval(timer);
  });
}
