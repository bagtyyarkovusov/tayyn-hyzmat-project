// Local (not push) notifications for incoming orders - "уведомление тоже
// должно быть [когда приложение не открыто], но если приложение открыто -
// уведомление должно исчезнуть как прочитано". This is deliberately the
// standard Web Notifications API, not @capacitor/push-notifications: real
// push needs a server sending through a real Firebase project, which this
// deployment doesn't have yet (see android/README.md "Push-уведомления").
// This only fires from JS that's already running - it can tell the driver
// about a new order while the app is backgrounded-but-alive, not wake the
// app up from fully killed/swiped-away, which only real push can do.
let currentNotification = null

export function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

export function notifyNewOrder(order) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  // The in-app "Новый заказ" bottom sheet already shows instantly while the
  // app is open - a stacked OS notification on top of it would just be
  // noise, so this only ever fires while backgrounded.
  if (!document.hidden) return

  closeCurrentNotification()
  try {
    currentNotification = new Notification('Новый заказ', {
      body: [order.pickupAddress, order.dropoffAddress].filter(Boolean).join(' → ') || 'Откройте приложение, чтобы посмотреть',
      tag: 'order-new', // replaces any earlier one instead of stacking
      requireInteraction: true
    })
    currentNotification.onclick = () => {
      if (typeof window.focus === 'function') window.focus()
      closeCurrentNotification()
    }
  } catch (err) {
    // A handful of older Android System WebView builds throw on
    // `new Notification()` even when the constructor exists - never let a
    // notification failure interrupt actually handling the order.
  }
}

export function closeCurrentNotification() {
  if (currentNotification) {
    currentNotification.close()
    currentNotification = null
  }
}

// The moment the driver brings the app back to the foreground, whatever
// order notification is showing has already been seen in-app - clear it
// "как прочитано" instead of leaving it sitting in the OS tray.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) closeCurrentNotification()
  })
}
