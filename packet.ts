import { Result } from "true-myth";

/** Size that the two null bytes at the end of the packet take up */
export const PACKET_PADDING_SIZE: number = 2;

/**
 * The header is this size, id, and type, but note tha
 * the `size` portion excludes its own size, so this is only 8
 * instead of 12.
 */
export const PACKET_HEADER_SIZE: number = 8;

/** Minimum possible size of a packet, which is a packet with no body. */
export const MIN_PACKET_SIZE: number = PACKET_PADDING_SIZE + PACKET_HEADER_SIZE;

/**  Maximum packet size supported by protocol. */
export const MAX_PACKET_SIZE: number = 4096 + MIN_PACKET_SIZE;

/** Maximum possible signed 32 bit integer. */
export const MAX_I32: number = 2_147_483_647;

/** Describes valid i32 packet types */
export type PacketType = 0 | 2 | 3;

/** The first packet sent by the client, and is used to auth with the server */
export const SERVERDATA_AUTH: PacketType = 3;

/**
 * The server's response to a SERVERDATA_AUTH packet. Possibly preceded
 * by an SERVERDATA_RESPONSE_VALUE with an empty body, depending on the
 * server's implementation.
 *
 * If auth was successful, packet will mirror the id of the auth request.
 * Otherwise, the id will be -1.
 */
export const SERVERDATA_AUTH_RESPONSE: PacketType = 2;

/** For packets containing a command to be issued to the server */
export const SERVERDATA_EXECCOMMAND: PacketType = 2;

/**
 * Response to a SERVERDATA_EXECCOMMAND packet. The id will mirror the id
 * of the SERVERDATA_EXECCOMMAND packet.
 */
export const SERVERDATA_RESPONSE_VALUE: PacketType = 0;

/** Represents a packet for the RCON protocol. Guaranteed to be valid once instantiated. */
export class Packet {
  readonly #size: number;
  readonly #id: number;
  readonly #type: PacketType;
  readonly #body: string;

  /**
   * The packet size is a 32-bit little endian integer, representing the length
   * of the request in bytes. Note that the packet size field itself is *not*
   * included when determining the size of the packet, so the value of this
   * field is always 4 less than the packet's actual length.
   */
  get size() {
    return this.#size;
  }

  /**
   * The packet ID is a 32-bit little endian integer chosen by the client for each request.
   * It may be set to any positive integer. When the server responds to the request, the response
   * packet will have the same packet id as the original request (unless it is a failed
   * SERVERDATA_AUTH_RESPONSE packet). It doesn't need to be unique, but if a unique
   * packet id *is* assigned, it can be used to match incoming responses to their
   * corresponding requests.
   */
  get id() {
    return this.#id;
  }

  /**
   * The packet type is a 32-bit little endian integer, which indicates the purpose of
   * the packet. Its value will always be 0, 2, or 3, depending on which of the following
   * request/response types the packet represents:
   *
   * 3 : `SERVERDATA_AUTH`
   * 2 : `SERVERDATA_AUTH_RESPONSE`
   * 2 : `SERVERDATA_EXECCOMMAND`
   * 0 : `SERVERDATA_RESPONSE_VALUE`
   *
   * Note that the repetition above is not an error, SERVERDATA_AUTH_RESPONSE and
   * SERVERDATA_EXECCOMMAND both have the numeric value of 2.
   */
  get type() {
    return this.#type;
  }

  /**
   * The packet body is a null-terminated string encoded in ASCII (i.e., ASCIIZ). Depending
   * on the packet type, it may contain either the RCON password for the server, the command
   * to be executed, or the server's response to a request.
   */
  get body() {
    return this.#body;
  }

  private constructor(type: PacketType, id: number, body: string) {
    this.#type = type;
    this.#id = id;
    this.#body = body;

    this.#size =
      Buffer.byteLength(body, "ascii") +
      PACKET_HEADER_SIZE +
      PACKET_PADDING_SIZE;
  }

  /**
   * Creates a new packet, and returns an error if the packet is invalid.
   * @param type The packet type (0, 2, or 3)
   * @param id The packet id (must be positive and less than 2^31 - 1, i.e. a positive signed i32)
   * @param body The packet body (must be ASCII and less than 4096 bytes)
   *
   * @returns A Result containing either the packet or an error
   */
  public static new(
    type: PacketType,
    id: number,
    body: string
  ): Result<Packet, Error> {
    if (![0, 2, 3].includes(type)) {
      return Result.err(
        new Error(`${type} is not a valid packet type. Must be 0, 2, or 3.`)
      );
    }

    if (id < 0) {
      return Result.err(new Error("id cannot be negative"));
    }

    if (id > MAX_I32) {
      return Result.err(
        new Error(
          `id must satisfy 0 <= id <= 2^31 - 1 (max signed 32 bit integer)`
        )
      );
    }

    if (body.length > 4096) {
      return Result.err(
        new Error("body length must satisfy 0 <= body.length <= 4096")
      );
    }

    return Result.ok(new this(type, id, body));
  }

  /**
   * Reads a packet from a buffer according to the RCON protocol.
   *
   * @param bytes The buffer to read from
   *
   * @returns A Result containing either the packet or an error
   */
  public static fromBytes(bytes: Buffer): Result<Packet, Error> {
    try {
      let n = 0;

      const size = bytes.readInt32LE(n);
      n += 4;

      if (size < MIN_PACKET_SIZE) {
        return Result.err(
          new Error("packet size was less than MIN_PACKET_SIZE")
        );
      }

      const id = bytes.readInt32LE(n);
      n += 4;

      const type = bytes.readInt32LE(n);
      n += 4;

      if (![0, 2, 3].includes(type)) {
        return Result.err(
          new Error(
            `${type} is not a valid packet type. Must be 0, 2, or 3. If this is expected for your game, please open a PR.`
          )
        );
      }

      let body = bytes.toString("utf8", n);
      n += Buffer.byteLength(body);

      if (body.substring(Buffer.byteLength(body) - 2) != "\x00\x00") {
        return Result.err(new Error("packet was padded/terminated improperly"));
      }

      body = body.substring(0, Buffer.byteLength(body) - 2);

      return Result.ok(new Packet(type as PacketType, id, body));
    } catch (e) {
      return Result.err(e as Error);
    }
  }

  /**
   * Serializes the packet into a buffer according to the RCON protocol.
   * Guaranteed to be valid.
   */
  public toBytes(): Buffer {
    let buf = Buffer.alloc(this.#size + 4);

    let n = buf.writeInt32LE(this.#size, 0);
    n = buf.writeInt32LE(this.#id, n);
    n = buf.writeInt32LE(this.#type, n);
    n += buf.write(this.#body, n, "ascii");

    // Null-terminate the string and the packet
    buf.set([0x00, 0x00], n);
    return buf;
  }

  public toString(): string {
    return `Packet { size: ${this.#size}, id: ${this.#id}, type: ${
      this.#type
    }, body: ${this.#body} }`;
  }
}
