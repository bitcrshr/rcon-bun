import { Maybe, Result } from "true-myth";
import { TcpStream } from "./tcp_stream";
import {
  Packet,
  SERVERDATA_AUTH,
  type PacketType,
  SERVERDATA_RESPONSE_VALUE,
  PACKET_HEADER_SIZE,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_EXECCOMMAND,
} from ".";

/** How long to wait for the initial connection before bailing (not implemented) */
const DEFAULT_DIAL_TIMEOUT = 5; // seconds

/** How long to wait for reads/writes to succeed before bailing */
const DEFAULT_DEADLINE = 5; // seconds

type PacketHeader = {
  size: number;
  id: number;
  type: PacketType;
};

export class RCONConnection {
  #stream!: TcpStream;

  private constructor() {}

  public static async dial(
    host: string,
    port: string | number,
    password: string
  ): Promise<Result<RCONConnection, Error>> {
    const maybeStream = await TcpStream.new(host, port);
    if (maybeStream.isErr) {
      return Result.err(maybeStream.error);
    }

    const stream = maybeStream.value;

    const conn = new RCONConnection();
    conn.#stream = stream;

    const maybeErr = await conn.#auth(password);
    if (maybeErr.isJust) {
      return Result.err(maybeErr.value);
    }

    return Result.ok(conn);
  }

  public close(): Maybe<Error> {
    try {
      this.#stream.close();

      return Maybe.nothing();
    } catch (e) {
      return Maybe.just(e as Error);
    }
  }

  public async execute(cmd: string): Promise<Result<String, Error>> {
    if (cmd == "") {
      return Result.err(new Error("Command cannot be empty"));
    }

    if (cmd.length > 4096) {
      return Result.err(new Error("Command cannot be longer than 4096 bytes"));
    }

    console.log(`executing command: ${cmd}`, cmd, cmd.length);

    const maybePacket = Packet.new(SERVERDATA_EXECCOMMAND, 0, cmd);
    if (maybePacket.isErr) {
      return Result.err(maybePacket.error);
    }
    const packet = maybePacket.value;

    console.log("writing packet:", packet.toString(), packet.toBytes());

    const maybeErr = await this.#stream.write(
      packet.toBytes(),
      DEFAULT_DEADLINE
    );
    if (maybeErr.isJust) {
      return Result.err(maybeErr.value);
    }

    console.log("wrote packet");

    const maybeHeader = await this.#readHeader();
    if (maybeHeader.isErr) {
      return Result.err(maybeHeader.error);
    }
    const [header, headerBuf] = maybeHeader.value;

    console.log("got header:", header, "buf:", headerBuf);

    const size = header.size - PACKET_HEADER_SIZE;

    const maybeBody = await this.#stream.read(size, DEFAULT_DEADLINE);
    if (maybeBody.isErr) {
      return Result.err(maybeBody.error);
    }

    console.log("got body:", maybeBody.value);

    if (header.type != SERVERDATA_RESPONSE_VALUE) {
      return Result.err(
        new Error(
          `Expected SERVERDATA_RESPONSE_VALUE, got ${header.type} instead`
        )
      );
    }

    if (header.id != packet.id) {
      return Result.err(
        new Error(`Expected id ${packet.id}, got ${header.id} instead`)
      );
    }

    const maybeRes = Packet.fromBytes(
      Buffer.concat([headerBuf, maybeBody.value])
    );
    if (maybeRes.isErr) {
      return Result.err(maybeRes.error);
    }

    const res = maybeRes.value;

    console.log("got response:", res.toString());

    return Result.ok(res.body);
  }

  async #auth(password: string): Promise<Maybe<Error>> {
    const maybePacket = Packet.new(SERVERDATA_AUTH, 0, password);
    if (maybePacket.isErr) {
      return Maybe.just(maybePacket.error);
    }

    const packet = maybePacket.value;

    console.log("packet:", packet.toString());

    console.log("writing packet:", packet.toBytes());

    const maybeErr = await this.#stream.write(
      packet.toBytes(),
      DEFAULT_DEADLINE
    );
    if (maybeErr.isJust) {
      return Maybe.just(maybeErr.value);
    }

    console.log("reading header");
    const maybeHeader = await this.#readHeader();
    if (maybeHeader.isErr) {
      return Maybe.just(maybeHeader.error);
    }

    let [header, buf] = maybeHeader.value;
    console.log("got header:", header, "buf", buf);

    const size = header.size - PACKET_HEADER_SIZE;

    // Some servers send an empty SERVERDATA_RESPONSE_VALUE followed immediately
    // by a SERVERDATA_AUTH_RESPONSE. We need to discard the first packet and read
    // again if this is a case.
    if (header.type == SERVERDATA_RESPONSE_VALUE) {
      console.log("reading empty response");
      // Discard empty SERVERDATA_RESPONSE_VALUE from auth response
      const r = await this.#stream.read(size, DEFAULT_DEADLINE);
      if (r.isErr) {
        return Maybe.just(r.error);
      }
      console.log("read empty response");

      console.log("reading header again");
      const maybeHeader = await this.#readHeader();
      if (maybeHeader.isErr) {
        return Maybe.just(maybeHeader.error);
      }

      [header] = maybeHeader.value;
      console.log("got new header:", header);
    }

    // now we get the body

    console.log("reading body, size:", size);
    const maybeBody = await this.#stream.read(size, DEFAULT_DEADLINE);
    if (maybeBody.isErr) {
      return Maybe.just(maybeBody.error);
    }

    console.log("got body:", maybeBody.value);

    if (header.type != SERVERDATA_AUTH_RESPONSE) {
      return Maybe.just(
        new Error(
          `Expected SERVERDATA_AUTH_RESPONSE, got ${header.type} instead`
        )
      );
    }

    if (header.id == -1) {
      return Maybe.just(new Error("Authentication failed"));
    }

    if (header.id != packet.id) {
      return Maybe.just(
        new Error(`Expected id ${packet.id}, got ${header.id} instead`)
      );
    }

    return Maybe.nothing();
  }

  async #readHeader(): Promise<Result<[PacketHeader, Buffer], Error>> {
    const maybeBuf = await this.#stream.read(12, DEFAULT_DEADLINE);
    if (maybeBuf.isErr) {
      return Result.err(maybeBuf.error);
    }

    const buf = maybeBuf.value;

    try {
      const size = buf.readInt32LE(0);
      const id = buf.readInt32LE(4);
      const type = buf.readInt32LE(8);

      return Result.ok([{ size, id, type: type as PacketType }, buf]);
    } catch (e) {
      return Result.err(e as Error);
    }
  }
}
