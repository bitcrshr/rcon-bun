import { Result, Maybe } from "true-myth";
import { nanoid } from "nanoid";
import Deque from "double-ended-queue";
import { ArrayBufferSink } from "bun";

/** The underlying socket type provided by Bun */
type Socket = Awaited<ReturnType<typeof Bun.connect>>;

/** Represents a client connection to a TCP socket */
export class TcpStream {
  /** Underlying socket connection */
  #sock!: Socket;

  /** Incoming data is buffered into this until ready to be read */
  #readBuf: Deque<Uint8Array> = new Deque(512);

  /** Handlers interested in the data event */
  #dataHandlers: Record<string, (data: Buffer) => void> = {};

  /** Handlers interested in the drain event */
  #drainHandlers: Record<string, (socket: Socket) => void> = {};

  private constructor() {}

  /**
   * Creates a new TCPStream and attempts to connect to the given host and port.
   *
   * @param hostname The hostname to connect to
   * @param port The port to connect to
   *
   * @returns A Result containing either the TcpStream or an error
   */
  public static async new(
    hostname: string,
    port: string | number
  ): Promise<Result<TcpStream, Error>> {
    try {
      if (typeof port === "string") {
        port = parseInt(port);
      }

      const stream = new TcpStream();

      // todo: figure out how to get a connect timeout
      stream.#sock = await Bun.connect({
        hostname,
        port,
        socket: {
          data: (_, data) => {
            console.log("got data!", data);
            stream.#readBuf.enqueue(data);

            for (const handle of Object.values(stream.#dataHandlers)) {
              handle(data);
            }
          },

          drain: (socket) => {
            for (const handle of Object.values(stream.#drainHandlers)) {
              handle(socket);
            }
          },
        },
      });

      return Result.ok(stream);
    } catch (e) {
      return Result.err(e as Error);
    }
  }

  /**
   * Writes data to the socket with an optional deadline. Will resolve either
   * once all data has been written, and error occurs, or the deadline is reached.
   *
   * @param buf The data to write to the socket
   * @param deadlineSeconds The deadline in seconds to write the data by. Ignored if 0 or negative.
   *
   * @returns a Maybe that is nothing if the write was successful, or an error if it failed.
   */
  public async write(
    buf: Buffer,
    deadlineSeconds?: number
  ): Promise<Maybe<Error>> {
    let writeBuf = new ArrayBufferSink();
    writeBuf.start({
      asUint8Array: true,
      highWaterMark: buf.byteLength,
      stream: true,
    });
    writeBuf.write(buf);

    let timedOut = false;

    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

    if (deadlineSeconds && deadlineSeconds > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
      }, 1000 * deadlineSeconds);
    }

    try {
      let data = writeBuf.flush() as Uint8Array;
      let wrote = this.#sock.write(data);

      while (wrote < buf.byteLength) {
        if (timedOut) {
          return Maybe.just(
            new Error(
              `Timeout: writing to socket took longer than ${deadlineSeconds} seconds`
            )
          );
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
      clearTimeout(timeout);
    }
  }

  /**
   * Reads a specific number of bytes from the socket. If the number of bytes
   * requested is not currently available on the socket, will wait until they are
   * available or the deadline is reached (if any).
   *
   * @param bytes The number of bytes to read from the socket
   * @param deadlineSeconds The deadline in seconds to read the data by. Ignored if 0 or negative.
   * @returns A Result containing either the bytes read or an error
   */
  public async read(
    bytes: number,
    deadlineSeconds?: number
  ): Promise<Result<Buffer, Error>> {
    return new Promise<Result<Buffer, Error>>((resolve) => {
      const listenerId = nanoid();
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
      console.log("reading ", bytes, "bytes");
      let buf: Maybe<Buffer> = Maybe.nothing();

      console.log("current readbuf:", this.#readBuf.toArray());

      if (this.#bufByteLength() > 0 && this.#bufByteLength() >= bytes) {
        console.log(
          `readbuf has enough bytes (${this.#bufByteLength()}) to read ${bytes} bytes`
        );
        const maybeBuf = this.#readBytesFromBuf(bytes);
        resolve(maybeBuf);
        return;
      } else if (this.#bufByteLength() > 0) {
        console.log(
          `readbuf has ${this.#bufByteLength()} bytes, but not enough to read ${bytes} bytes`
        );
        const maybeBuf = this.#readBytesFromBuf(this.#bufByteLength());
        if (maybeBuf.isErr) {
          resolve(Result.err(maybeBuf.error));
          return;
        } else {
          buf = Maybe.just(maybeBuf.value);
        }
      } else {
        console.log("readbuf is empty, need to get all bytes from stream");
      }

      if (deadlineSeconds && deadlineSeconds > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          this.#dataHandlers[listenerId] &&
            delete this.#dataHandlers[listenerId];
          resolve(
            Result.err(
              new Error(
                `Timeout: waited for ${deadlineSeconds} but did not receive enough data.`
              )
            )
          );
        }, 1000 * deadlineSeconds);

        console.log("set timeout with id:", timeout);
      }

      if (!timedOut) {
        this.#dataHandlers[listenerId] = () => {
          if (this.#bufByteLength() >= bytes) {
            delete this.#dataHandlers[listenerId];
            const newBuf = this.#readBytesFromBuf(
              bytes - (buf.isJust ? buf.value.byteLength : 0)
            );
            clearTimeout(timeout);
            console.log("cleared timeout with id:", timeout);
            if (newBuf.isErr) {
              resolve(Result.err(newBuf.error));
              return;
            }

            if (buf.isJust) {
              resolve(Result.ok(Buffer.concat([buf.value, newBuf.value])));
            } else {
              resolve(Result.ok(newBuf.value));
            }
          }
        };
      } else {
        delete this.#dataHandlers[listenerId];
      }
    });
  }

  /**
   * The read buffer is really an array of buffers, so this calculates
   * the total bytes held in the read buffer.
   */
  #bufByteLength(): number {
    if (this.#readBuf.isEmpty()) {
      return 0;
    }

    let len = 0;
    for (let i = 0; i < this.#readBuf.length; i++) {
      len += this.#readBuf.get(i)!.byteLength ?? 0;
    }

    return len;
  }

  /**
   * Closes the underlying socket connection.
   */
  public close() {
    this.#sock.end();
  }

  /**
   * Reads a specific number of bytes from the read buffer, and expects
   * that those bytes are available. If they are not, an error is returned.
   *
   * @param bytes The number of bytes to read from the read buffer
   * @returns A Result containing either the bytes read or an error
   */
  #readBytesFromBuf(bytes: number): Result<Buffer, Error> {
    console.log(
      "readBuf before read:",
      this.#readBuf.toArray(),
      "was reading",
      bytes,
      "bytes"
    );
    const bufByteLength = this.#bufByteLength();

    if (bytes > bufByteLength) {
      return Result.err(
        new Error(
          `buffer only has ${bufByteLength} bytes but tried to read ${bytes}`
        )
      );
    }

    let buf = Buffer.alloc(bytes, 0, "binary");
    let bytesWritten = 0;

    while (bytesWritten < bytes) {
      const chunk = this.#readBuf.dequeue()!;

      // we're almost done, but the last chunk has more data than we need
      if (buf.byteLength + chunk.byteLength > bytes) {
        console.log(
          "bytes",
          bytes,
          "chunk.byteLength",
          chunk.byteLength,
          "buf.byteLength",
          buf.byteLength
        );
        let leftover = Buffer.alloc(chunk.byteLength - bytes);
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
        bytesWritten += chunk.byteLength;
      }
    }

    console.log(
      "readBuf after read:",
      this.#readBuf.toArray(),
      "was reading",
      bytes,
      "bytes"
    );

    return Result.ok(buf);
  }
}
