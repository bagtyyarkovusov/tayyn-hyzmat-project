import { onUnmounted, ref, watch, type Ref } from "vue";

// Open order, rather than component/DOM order, determines which overlay owns Back.
const stack: Array<{ close: () => void }> = [];
export const overlayRevision = ref(0);
export function closeTopOverlay() {
  const top = stack.at(-1);
  if (!top) return false;
  top.close();
  return true;
}
export function useOverlay(open: Ref<boolean>) {
  const entry = {
    close: () => {
      open.value = false;
    },
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
        stack.push(entry);
        overlayRevision.value++;
      }
    },
    { immediate: true, flush: "sync" },
  );
  onUnmounted(remove);
}
