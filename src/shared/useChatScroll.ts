import { nextTick, onMounted, onUnmounted, ref } from "vue";
/** Own the message pane, without scrolling the app shell or interrupting history reading. */
export function useChatScroll() {
  const history = ref<HTMLElement>();
  let following = true;
  function track() {
    const el = history.value;
    if (el) following = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }
  async function updated(force = false) {
    const shouldFollow = force || following;
    await nextTick();
    const el = history.value;
    if (el && shouldFollow) {
      el.scrollTop = el.scrollHeight;
      following = true;
    }
  }
  let resize: ResizeObserver | undefined;
  onMounted(() => {
    resize = new ResizeObserver(() => void updated());
    if (history.value) resize.observe(history.value);
  });
  onUnmounted(() => resize?.disconnect());
  return { history, track, updated };
}
