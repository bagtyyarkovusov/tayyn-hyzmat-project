// Audible alert for "Новый заказ" (order/applyNewOrder) - plays
// notification.mp3 (a static file from the project root, copied into the
// build by scripts/prepare-driver-dist.js). Replaced an earlier
// synthesized Web Audio chime with this real sound file per explicit
// request. Plays reliably whether the app is foregrounded or backgrounded,
// which is the case localNotify.js's OS notification deliberately does NOT
// cover (it only fires while backgrounded, relying on the in-app popup
// while open) - a driver staring at an already-open app is exactly when a
// new order needs an audible cue the most, since nothing else makes a
// sound for it.
const SOUND_URL = '/notification.mp3';

let audio = null;
function getAudio() {
  if (!audio) {
    audio = new Audio(SOUND_URL);
    audio.preload = 'auto';
  }
  return audio;
}

// Browsers (Android WebView included) refuse to actually play an
// <audio>/Audio() element via .play() - the returned promise rejects with
// NotAllowedError - until the page has seen a real user gesture. Playing
// (then immediately pausing) from inside a genuine gesture handler is the
// standard way to "unlock" the element for later programmatic play() calls
// for the rest of the page's lifetime. DriverApp.vue calls this once,
// app-wide, on the driver's first tap anywhere (logging in, if nothing
// else) - by the time a real order can arrive, playback is already unlocked.
let primed = false;
export function primeAudioOnFirstInteraction() {
  if (primed || typeof window === 'undefined') return;
  primed = true;
  const unlock = () => {
    const el = getAudio();
    const playPromise = el.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          el.pause();
          el.currentTime = 0;
        })
        .catch(() => {
          // Couldn't unlock yet (gesture didn't count, autoplay policy
          // variant, etc.) - the next real attempt just tries again and
          // fails silently the same way; never let this block anything.
        });
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
}

export function playNewOrderChime() {
  try {
    const el = getAudio();
    el.currentTime = 0;
    const playPromise = el.play();
    if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
  } catch (err) {
    // Never let a sound failure interrupt actually handling the order.
  }
}

// notification.mp3 runs for several seconds - once the driver has actually
// answered the order (accepted, declined, or someone else took it), leaving
// it ringing is just noise, so every one of those paths stops it (see
// store/modules/order.js).
export function stopNewOrderChime() {
  try {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  } catch (err) {
    // Same as above - never let audio get in the way of the order flow.
  }
}
