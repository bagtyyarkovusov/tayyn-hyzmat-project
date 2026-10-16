import { nextTick, onMounted, onUnmounted, ref } from "vue";
/** Own the message pane, without scrolling the app shell or interrupting history reading. */
export function useChatScroll() {
  const history = ref<HTMLElement>();
  let following = true;
  let scrollVersion = 0;
  function track() {
    const el = history.value;
    if (el) {
      scrollVersion++;
      following = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    }
  }
  async function updated(force = false) {
    const version = scrollVersion;
    await nextTick();
    const el = history.value;
    if (el && (following || (force && version === scrollVersion))) {
      el.scrollTop = el.scrollHeight;
      following = true;
    }
  }
  function followAfterSend() {
    const version = scrollVersion;
    return () => updated(version === scrollVersion);
  }
  let resize: ResizeObserver | undefined;
  onMounted(() => {
    resize = new ResizeObserver(() => void updated());
    if (history.value) resize.observe(history.value);
  });
  onUnmounted(() => resize?.disconnect());
  return { history, track, updated, followAfterSend };
}
