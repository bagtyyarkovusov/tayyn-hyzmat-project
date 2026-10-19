import { onUnmounted, ref, watch, type Ref } from "vue";

type Entry = { close: () => void; openedAt: number; backGuardMs: number };
// Open order, rather than component/DOM order, determines which overlay owns Back.
const stack: Entry[] = [];
export const overlayRevision = ref(0);
/** "closed" asked the top overlay to close (it may refuse and stay open).
 * "guarded" means the top overlay opened within its Back guard and was left
 * open. "none" means no overlay is open. */
export function closeTopOverlay(
  now = performance.now(),
): "closed" | "guarded" | "none" {
  const top = stack.at(-1);
  if (!top) return "none";
  if (now - top.openedAt < top.backGuardMs) return "guarded";
  top.close();
  return "closed";
}
export function useOverlay(
  open: Ref<boolean | undefined>,
  backGuardMs: () => number = () => 0,
) {
  const entry: Entry = {
    close: () => {
      open.value = false;
    },
    openedAt: 0,
    backGuardMs: 0,
  };
  function remove() {
    const index = stack.indexOf(entry);
    if (index < 0) return;
    stack.splice(index, 1);
    overlayRevision.value++;
  }
  watch(
    open,
    (active) => {
      remove();
      if (active) {
        entry.openedAt = performance.now();
        entry.backGuardMs = backGuardMs();
        stack.push(entry);
        overlayRevision.value++;
      }
    },
    { immediate: true, flush: "sync" },
  );
  onUnmounted(remove);
}
