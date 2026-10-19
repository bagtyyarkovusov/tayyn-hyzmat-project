const cooldownMs = 3_000;
const maximumPlaybackMs = 750;

/** Optional browser audio. Banners remain available when coordination or audio fails. */
export function createAdminChatSound(adminId: () => string | null) {
  // Logout clears the reactive account before this shell unmounts. Cleanup
  // must still target the account that received this tab's message preview.
  const account = adminId();
  let disposed = false;
  let requestedMessageId: string | null = null;
  let playing: { id: string; audio: HTMLAudioElement } | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new Set<string>();

  function key(id: string) {
    return `tayyn.admin.chat-sound.${id}`;
  }

  function stopLocal(id?: string) {
    if (!playing || (id && playing.id !== id)) return;
    clearTimeout(deadline);
    const { audio } = playing;
    playing = null;
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // Media failures must not block closing a banner or changing screens.
    }
  }

  function rememberCancellation(id: string) {
    cancelled.add(id);
    if (cancelled.size > 100)
      cancelled.delete(cancelled.values().next().value as string);
    stopLocal(id);
  }

  function storageChanged(event: StorageEvent) {
    if (!account || event.key !== `${key(account)}.cancel` || !event.newValue)
      return;
    try {
      const payload = JSON.parse(event.newValue);
      if (typeof payload.id === "string") rememberCancellation(payload.id);
    } catch {
      // Invalid or unavailable storage must never interrupt chat.
    }
  }
  window.addEventListener("storage", storageChanged);

  function cancel(id: string) {
    rememberCancellation(id);
    if (!account) return;
    try {
      // Dismiss is local UI state, not a shared read acknowledgement. Only the
      // currently sounding/pending message is silenced in the other tabs.
      localStorage.setItem(
        `${key(account)}.cancel`,
        JSON.stringify({ id, nonce: crypto.randomUUID() }),
      );
    } catch {
      // Without storage this tab is still silenced immediately.
    }
  }

  async function play(id: string, isCurrent: () => boolean) {
    const eligible = () =>
      !disposed &&
      adminId() === account &&
      !cancelled.has(id) &&
      requestedMessageId === id &&
      isCurrent();
    requestedMessageId = id;
    if (!account || !eligible()) return;
    if (!navigator.locks) return;
    try {
      await navigator.locks.request(key(account), () => {
        if (!eligible()) return;
        const cancellation = localStorage.getItem(`${key(account)}.cancel`);
        if (cancellation && JSON.parse(cancellation).id === id) return;
        const eventKey = `${key(account)}.events`;
        const heard: string[] = JSON.parse(
          localStorage.getItem(eventKey) || "[]",
        );
        const identity = `chat:${id}`;
        if (heard.includes(identity)) return;
        const remember = () =>
          localStorage.setItem(
            eventKey,
            JSON.stringify([...heard.slice(-99), identity]),
          );
        const now = Date.now();
        const last = Number(localStorage.getItem(key(account)));
        if (last > 0 && now >= last && now - last < cooldownMs) {
          // Rapid chat bursts share one chime, even across tabs.
          remember();
          return;
        }
        // Claim the shared cooldown under the lock before any playback. If
        // storage is unavailable, fail silent rather than duplicate tab audio.
        localStorage.setItem(key(account), String(now));
        remember();
        if (!eligible()) return;
        stopLocal();
        const audio = new Audio("/sounds/admin-chat-chime.wav");
        audio.volume = 0.25;
        audio.loop = false;
        playing = { id, audio };
        const stop = () => {
          if (playing?.audio === audio) stopLocal(id);
          else {
            try {
              audio.pause();
            } catch {
              // A previously cancelled media element needs no further work.
            }
          }
        };
        audio.onended = stop;
        audio.onerror = stop;
        // Bound playback even if the asset or media callback ever regresses.
        deadline = setTimeout(stop, maximumPlaybackMs);
        void audio.play().then(() => {
          if (!eligible()) stop();
        }, stop);
      });
    } catch {
      // Autoplay, storage and Web Locks are optional; never retry old sounds.
      stopLocal(id);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (requestedMessageId) cancel(requestedMessageId);
    window.removeEventListener("storage", storageChanged);
    stopLocal();
  }

  return { play, cancel, dispose };
}
