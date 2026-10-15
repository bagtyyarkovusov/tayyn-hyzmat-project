// navigator.onLine / online-offline events are a reliable, standard signal
// (unlike geolocation's on/off state) - no heuristics needed here.
export function watchNetwork(onChange) {
  const update = () => onChange(navigator.onLine);
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}
