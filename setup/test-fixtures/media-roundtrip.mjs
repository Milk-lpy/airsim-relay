// Isolated TLS client for the runtime integration test. No system trust settings are changed.
import assert from 'node:assert/strict';


let phase = 'read URL';
const timeout = setTimeout(() => { throw new Error('Timed out awaiting ' + phase); }, 8000);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const sockets = [];
async function connect(role) {
  const url = new URL(input);
  url.searchParams.set('role', role);
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', () => reject(new Error(role + ' WSS connection failed')), {once:true});
  });
  return socket;
}
function receive(socket) {
  return new Promise(resolve => {
    function onMessage(event) {
      if (!(event.data instanceof ArrayBuffer)) return;
      socket.removeEventListener('message', onMessage);
      resolve([...new Uint8Array(event.data)]);
    }
    socket.addEventListener('message', onMessage);
  });
}
try {
  phase = 'agent WSS';
  const android = await connect('agent');
  phase = 'iPhone WSS';
  const iphone = await connect('iphone');
  const atAndroid = receive(android), atIphone = receive(iphone);
  iphone.send(JSON.stringify({ action:'answer' }));
  iphone.send(Uint8Array.of(5,6,7,8));
  android.send(Uint8Array.of(1,2,3,4));
  phase = 'audio at Android';
  assert.deepEqual(await atAndroid, [5,6,7,8]);
  phase = 'audio at iPhone';
  assert.deepEqual(await atIphone, [1,2,3,4]);
} finally {
  phase = 'WSS close';
  await Promise.all(sockets.map(socket => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.addEventListener('close', resolve, {once:true});
    socket.close(1000, 'complete');
  })));
  clearTimeout(timeout);
}
