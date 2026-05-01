import { io } from 'socket.io-client';

const SERVER_URL  = 'https://ghumobackend.onrender.com';
const CUSTOMER_ID = '69ec50ab70f25017fa1b87a6';

const PICKUP_LNG = 78.4554;   // ← your driver's actual location
const PICKUP_LAT = 17.3734;   // ← your driver's actual location

const DROP_LNG = 78.4720;
const DROP_LAT = 17.3850;

const VEHICLE_TYPE   = 'auto';
const TOTAL_REQUESTS = 10;

const results = [];

function sendOneRequest(index) {
  return new Promise((resolve) => {
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      reconnection: false,
    });

    const label = `Request #${String(index + 1).padStart(2, '0')}`;
    let done = false;

    const finish = (status, detail = '') => {
      if (done) return;
      done = true;
      results.push({ index: index + 1, status, detail });
      console.log(`  [${label}] ${status}${detail ? '  →  ' + detail : ''}`);
      socket.disconnect();
      resolve();
    };

    const timeout = setTimeout(() => {
      finish('⚠️  TIMEOUT', 'No response in 20s — open /health in browser first');
    }, 20000);

    socket.on('connect', () => {
      socket.emit('user:connect', {
        userId: CUSTOMER_ID,
        role: 'customer',
      });
      setTimeout(() => {
        socket.emit('customer:request_trip', {
          type: 'short',
          customerId: CUSTOMER_ID,
          vehicleType: VEHICLE_TYPE,
          paymentMethod: 'cash',
          fare: 80,
          pickup: {
            coordinates: [PICKUP_LNG, PICKUP_LAT],
            address: 'Test Pickup, Hyderabad',
          },
          drop: {
            coordinates: [DROP_LNG, DROP_LAT],
            address: 'Test Drop, Hyderabad',
          },
        });
      }, 400);
    });

    socket.on('trip:request_response', (data) => {
      clearTimeout(timeout);
      if (data.success && data.tripId) {
        finish('✅ CREATED', `tripId=${data.tripId}   drivers=${data.drivers ?? '?'}`);
      } else {
        finish('❌ REJECTED', data.message || JSON.stringify(data));
      }
    });

    socket.on('trip:error', (data) => {
      clearTimeout(timeout);
      finish('⚠️  TRIP_ERROR', data.message || JSON.stringify(data));
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      finish('🔴 CONN_ERROR', err.message);
    });

    socket.on('disconnect', () => {
      clearTimeout(timeout);
      if (!done) finish('⚠️  DISCONNECTED', 'Socket closed before response');
    });
  });
}

async function run() {
  console.log('');
  console.log('═'.repeat(62));
  console.log('🚀  Ghumo Driver Load Test');
  console.log('═'.repeat(62));
  console.log(`   Server      : ${SERVER_URL}`);
  console.log(`   Customer    : Mahesh (${CUSTOMER_ID})`);
  console.log(`   Vehicle     : ${VEHICLE_TYPE}`);
  console.log(`   Pickup      : [${PICKUP_LNG}, ${PICKUP_LAT}]`);
  console.log(`   Requests    : ${TOTAL_REQUESTS}`);
  console.log('═'.repeat(62));
  console.log('');

  const promises = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    promises.push(sendOneRequest(i));
    await new Promise(r => setTimeout(r, 200));
  }

  await Promise.all(promises);

  const created  = results.filter(r => r.status.startsWith('✅')).length;
  const rejected = results.filter(r => r.status.startsWith('❌')).length;
  const other    = results.filter(r => !r.status.startsWith('✅') && !r.status.startsWith('❌')).length;

  console.log('');
  console.log('═'.repeat(62));
  console.log('📊  Summary');
  console.log('─'.repeat(62));
  console.log(`   ✅ Trip Created    : ${created}`);
  console.log(`   ❌ Rejected        : ${rejected}`);
  console.log(`   ⚠️  Timeout/Error  : ${other}`);
  console.log('═'.repeat(62));
  console.log('');

  if (created > 0)  console.log('✅ Driver app should now show trip requests!\n');
  if (other > 0)    console.log('⚠️  Open /health in browser first, then retry\n');
  if (rejected > 0) console.log('❌ Check driver is online and coords are correct\n');
}

run();