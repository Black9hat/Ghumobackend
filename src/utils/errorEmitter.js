import { io } from '../socket/socketHandler.js';
import { sendToCustomer } from './fcmSender.js';

/**
 * Emit a trip error to the customer via socket or FCM.
 * @param {Object} params
 * @param {Object} [params.socket] - Socket.IO socket instance (optional)
 * @param {Object} [params.customer] - Customer user document (optional)
 * @param {string} [params.tripId] - Trip ID (optional)
 * @param {string} params.message - Error message (required)
 */
const emitTripError = ({ socket, customer, tripId, message }) => {
  const payload = { tripId, message };

  if (socket) {
    socket.emit('trip:error', payload);
    console.log(`❗ trip:error emitted to socket (${socket.id})`, payload);
  }

  if (customer?.socketId) {
    io.to(customer.socketId).emit('trip:error', payload);
    console.log(`❗ trip:error emitted to customer socket (${customer.socketId})`, payload);
  }

  if (customer?.fcmToken) {
    sendToCustomer(
      customer.fcmToken,
      'Trip Error',
      message,
      { tripId }
    );
    console.log(`❗ trip:error FCM push sent to customer (${customer._id})`, payload);
  }
};

export { emitTripError };