// Holds the single Socket.IO server instance after it is created in
// sockets/index.js, so any service/controller can emit events without
// importing sockets/index.js directly (which would create a require cycle,
// since sockets/index.js itself calls into services).
let io = null;

function setIO(instance) {
  io = instance;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.IO has not been initialized yet');
  }
  return io;
}

module.exports = { setIO, getIO };
