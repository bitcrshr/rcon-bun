import { TcpStream } from './tcp_stream';

const host = process.env.SERVER_HOST;
const port = process.env.SERVER_PORT;

const stream = (await TcpStream.new(host!, port!)).unwrapOrElse((e) => {
  throw e;
});


const rconAuthPacketUint8Array = Uint8Array.from([
  0x16, 0x00, 0x00, 0x00, // size
  0x39, 0x30, 0x00, 0x00, //id
  0x03, 0x00, 0x00, 0x00, // type
  0x62, 0x6f, 0x6f, 0x67, 0x65, 0x72, 0x62, 0x65, 0x61, 0x6e, 0x33, 0x36, // body
  0x00, 0x00
])


console.log('writing packet:', rconAuthPacketUint8Array);

let err = await stream.write(Buffer.from(rconAuthPacketUint8Array), 5)
if (err.isJust) {
  console.error('failed to write auth packet', err.value);
  process.exit(1);
}

let packet = (await stream.read(14, 5)).unwrapOrElse((e) => {
  console.error('failed to get packet', e);
  process.exit(0);
});

console.log('got auth packet', packet);


const start = Date.now();
console.log('closing stream');
stream.close();
console.log(`stream took ${Date.now() - start} ms to close`);
