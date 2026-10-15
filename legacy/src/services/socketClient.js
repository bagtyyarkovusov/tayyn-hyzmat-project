import { io } from 'socket.io-client';

const socketUrl = process.env.VUE_APP_SOCKET_URL || process.env.VUE_APP_API_URL || 'http://localhost:4000';

let socket = null;

/**
 * Opens the realtime connection - shared by both the driver panel
 * (store/modules/driverAuth.js) and the admin panel
 * (store/modules/adminAuth.js) - and wires the events each cares about to
 * plain callback handlers. Handlers are passed in (rather than this module
 * importing the Vuex store directly) so this file has no dependency on the
 * store at all. One JWT per connection: logging into one panel disconnects
 * the other's socket, which matches a browser tab being logged into one
 * role at a time.
 *
 * `token` accepts a plain string OR a zero-arg function returning the
 * current token. Always pass a function (see driverAuth.js/adminAuth.js's
 * own callers) - access tokens expire after 15 minutes
 * (JWT_ACCESS_EXPIRES_IN), and this socket can easily outlive that: a
 * network blip, the app being backgrounded, or the server restarting for a
 * deploy (as happens routinely on this project) all trigger Socket.IO's
 * own `reconnection: true` retry, which re-sends whatever `auth` currently
 * evaluates to. A plain string captured once at the original connectSocket()
 * call keeps re-sending that same now-expired token forever - the socket
 * auth middleware on the backend rejects every retry, and the client never
 * rejoins its district room again, with no visible error beyond a
 * "WebSocket closed before the connection was established" console line.
 * REST calls stay unaffected (apiClient.js refreshes their own token on a
 * 401), which is exactly why this can look like "GPS still updates but no
 * new orders ever arrive" - confirmed as the actual cause of a live driver
 * silently stuck in this state after a backend restart. A function is
 * re-invoked on every (re)connection attempt, so it always sends whatever
 * tokenStorage/adminTokenStorage most recently refreshed.
 */
export function connectSocket(token, handlers = {}) {
  disconnectSocket();

  const getToken = typeof token === 'function' ? token : () => token;

  socket = io(socketUrl, {
    auth: (cb) => cb({ token: getToken() }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000
  });

  if (handlers.onConnect) socket.on('connect', handlers.onConnect);
  if (handlers.onDisconnect) socket.on('disconnect', handlers.onDisconnect);
  if (handlers.onBalanceUpdated) socket.on('balance:updated', handlers.onBalanceUpdated);
  if (handlers.onBlocked) socket.on('driver:blocked', handlers.onBlocked);
  if (handlers.onApproved) socket.on('driver:approved', handlers.onApproved);
  if (handlers.onAdminMessage) socket.on('admin:message', handlers.onAdminMessage);
  if (handlers.onDriverMessage) socket.on('driver:message', handlers.onDriverMessage);
  if (handlers.onDistrictsStats) socket.on('districts:stats', handlers.onDistrictsStats);
  if (handlers.onOrderNew) socket.on('order:new', handlers.onOrderNew);
  if (handlers.onOrderTaken) socket.on('order:taken', handlers.onOrderTaken);
  if (handlers.onOrderUpdate) {
    ['order:accepted', 'order:waiting', 'order:started', 'order:completed', 'order:cancelled'].forEach((event) =>
      socket.on(event, handlers.onOrderUpdate)
    );
  }

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}
