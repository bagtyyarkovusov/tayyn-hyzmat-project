const cooldownMs = 3_000;
const maximumPlaybackMs = 750;

/** Optional browser audio. Banners remain available when coordination or audio fails. */
export function createAdminChatSound(adminId: () => string | null) {
  let disposed = false;
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
    const account = adminId();
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
    const account = adminId();
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
    const account = adminId();
    const eligible = () =>
      !disposed && adminId() === account && !cancelled.has(id) && isCurrent();
    if (!account || !navigator.locks || !eligible()) return;
    try {
      await navigator.locks.request(key(account), () => {
        if (!eligible()) return;
        const cancellation = localStorage.getItem(`${key(account)}.cancel`);
        if (cancellation && JSON.parse(cancellation).id === id) return;
        const now = Date.now();
        const last = Number(localStorage.getItem(key(account)));
        if (last > 0 && now >= last && now - last < cooldownMs) return;
        // Claim the shared cooldown under the lock before any playback. If
        // storage is unavailable, fail silent rather than duplicate tab audio.
        localStorage.setItem(key(account), String(now));
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
    disposed = true;
    window.removeEventListener("storage", storageChanged);
    stopLocal();
  }

  return { play, cancel, dispose };
}
