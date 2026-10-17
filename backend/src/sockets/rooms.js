// Central place for Socket.IO room-name conventions, shared by the socket
// layer (sockets/index.js) and REST controllers/services that need to emit
// events triggered by an HTTP request (e.g. POST /driver/location).
module.exports = {
  user: (userId) => `user:${userId}`,
  admins: () => 'admins',
  drivers: () => 'drivers', // every connected driver socket, for global broadcasts
  driver: (driverId) => `driver:${driverId}`,
  district: (districtId) => `district:${districtId}`, // one specific dispatch zone - order broadcasts land here
  publicOrders: () => 'orders:public', // eligible shift-owner sockets; queue updates without popups
  districtsOverview: () => 'districts:overview', // every connected socket - the 9-card live counts grid
  order: (orderId) => `order:${orderId}`
};
