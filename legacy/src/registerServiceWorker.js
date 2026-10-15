/* eslint-disable no-console */

// This project is still under active, frequent deploys - a caching service
// worker (even with skipWaiting/clientsClaim) makes "did my change actually
// ship, or is this browser just showing a stale cached version" a recurring
// source of confusion, since a browser only re-checks for an update
// opportunistically (roughly once per navigation) rather than the instant a
// new one is deployed. Registration is switched off entirely for now; any
// service worker a browser already installed from an earlier build is
// actively unregistered (and its caches cleared) here so it can't keep
// serving stale content indefinitely. Revisit once deploys are infrequent
// enough for offline caching to be worth this tradeoff again.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
    .catch(() => {})

  if (window.caches && window.caches.keys) {
    window.caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => window.caches.delete(key))))
      .catch(() => {})
  }
}
