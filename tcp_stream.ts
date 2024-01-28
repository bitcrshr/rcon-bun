import { Result, Maybe } from 'true-myth';
import { nanoid } from 'nanoid';
import Deque from 'double-ended-queue';
import { ArrayBufferSink } from 'bun';

type Socket = Awaited<ReturnType<typeof Bun.connect>>;

export class TcpStream {
  #sock!: Socket;
  #readBuf: Deque<Uint8Array> = new Deque(512);
  #writeBuf: ArrayBufferSink = new ArrayBufferSink();
  #dataHandlers: Record<string, (data: Buffer) => void> = {};
  #drainHandlers: Record<string, (socket: Socket) => void> = {};

  private constructor() {
    this.#writeBuf.start({ stream: true, highWaterMark: 1024, asUint8Array: true });
  }

  public static async new(hostname: string, port: string | number): Promise<Result<TcpStream, Error>> {
    try {
      if (typeof port === 'string') {
        port = parseInt(port);
      }

      const stream = new TcpStream();

      stream.#sock = await Bun.connect({
        hostname,
        port,
        socket: {
          data: (_, data) => {
            console.log('stream got data:', data);

            stream.#readBuf.enqueue(data);

            for (const handle of Object.values(stream.#dataHandlers)) {
              handle(data);
            }
          },

          drain: (socket) => {
            for (const handle of Object.values(stream.#drainHandlers)) {
              handle(socket);
            }
          }
        }
      })

      return Result.ok(stream);
    } catch (e) {
      return Result.err(e as Error);
    }
  }

  public async write(buf: Buffer, deadlineSeconds?: number): Promise<Maybe<Error>> {
    let writeBuf = new ArrayBufferSink();
    writeBuf.start({ asUint8Array: true, highWaterMark: buf.byteLength, stream: true });
    writeBuf.write(buf);

    let timedOut = false;

    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

    if (deadlineSeconds && deadlineSeconds > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
      }, 1000 * deadlineSeconds)
    }

    try {
      let data = writeBuf.flush() as Uint8Array;
      let wrote = this.#sock.write(data);

      while (wrote < buf.byteLength) {
        if (timedOut) {
          return Maybe.just(new Error(`Timeout: writing to socket took longer than ${deadlineSeconds} seconds`))
        }

        writeBuf.write(data.subarray(wrote));

        const listenerId = nanoid();

        await new Promise<void>((resolve) => {
          this.#drainHandlers[listenerId] = () => {
            resolve();
          };
        });

        delete this.#drainHandlers[listenerId];

        data = writeBuf.flush() as Uint8Array;
        wrote += this.#sock.write(data);
      }

      return Maybe.nothing();
    } catch (e) {
      return Maybe.just(e as Error);
    } finally {
      writeBuf.end();
      clearTimeout(timeout)
    }
  }

  public async read(bytes: number, deadlineSeconds?: number): Promise<Result<Buffer, Error>> {
    return new Promise<Result<Buffer, Error>>((resolve) => {
      const listenerId = nanoid();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

      if (deadlineSeconds && deadlineSeconds > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          this.#dataHandlers[listenerId] && delete this.#dataHandlers[listenerId]
          resolve(Result.err(new Error(`Timeout: waited for ${deadlineSeconds} but did not receive enough data.`)))
        }, 1000 * deadlineSeconds);
      }

      if (!timedOut) {
        this.#dataHandlers[listenerId] = () => {
          if (this.#bufByteLength() >= bytes) {
            delete this.#dataHandlers[listenerId];
            clearTimeout(timeout);
            resolve(this.#readBytesFromBuf(bytes));
          }
        }
      } else {
        delete this.#dataHandlers[listenerId];
      }

    });
  }

  #bufByteLength(): number {
    if (this.#readBuf.isEmpty()) {
      return 0;
    }

    let len = 0;
    for (let i = 0; i < this.#readBuf.length; i++) {
      len += this.#readBuf.get(i)!.byteLength ?? 0
    }

    return len;
  }

  public close() {
    this.#sock.end();
  }

  // Reads a certain number of bytes from the buf. Will
  // return an error if the buf byteLength is less than `bytes`
  #readBytesFromBuf(bytes: number): Result<Buffer, Error> {
    const bufByteLength = this.#bufByteLength();

    if (bytes > bufByteLength) {
      return Result.err(new Error(`buffer only has ${bufByteLength} bytes but tried to read ${bytes}`))
    }

    let buf = Buffer.alloc(bytes, 0, 'binary')
    let bytesWritten = 0;

    while (bytesWritten < bytes) {
      const chunk = this.#readBuf.dequeue()!;

      // we're almost done, but the last chunk has more data than we need
      if (buf.byteLength + chunk.byteLength > bytes) {
        let leftover = Buffer.alloc(bytes - chunk.byteLength);
        console.log(`need to read ${bytes} bytes, readBuf has ${bufByteLength} bytes, chunk has ${chunk.byteLength} bytes, so leftover should have ${bytes - chunk.byteLength} bytes allocated.`)
        let leftoverBytesWritten = 0;

        for (const byte of chunk) {
          if (bytesWritten < bytes) {
            buf.writeUint8(byte, bytesWritten);
            bytesWritten++;
          } else {
            leftover.writeUint8(byte, leftoverBytesWritten);
            leftoverBytesWritten++;
          }
        }

        // put back the unread bytes
        this.#readBuf.insertFront(leftover);
      } else {
        buf.set(chunk, bytesWritten);
        bytesWritten += chunk.byteLength
      }
    }

    return Result.ok(buf);
  }
}


