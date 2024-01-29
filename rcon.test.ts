import { expect, test, beforeAll } from "bun:test";
import { RCONConnection } from ".";

let host: string;
let port: string;
let password: string;

beforeAll(() => {
  if (!process.env.RCON_HOST) {
    throw new Error("RCON_HOST environment variable not set -- cannot test");
  }

  if (!process.env.RCON_PORT) {
    throw new Error("RCON_PORT environment variable not set -- cannot test");
  }

  if (!process.env.RCON_PASSWORD) {
    throw new Error(
      "RCON_PASSWORD environment variable not set -- cannot test"
    );
  }

  host = process.env.RCON_HOST;
  port = process.env.RCON_PORT;
  password = process.env.RCON_PASSWORD;
});

test("it connects", async () => {
  const conn = await RCONConnection.dial(host, port, password);
  if (conn.isErr) {
    console.error(conn.error);
    throw conn.error;
  }

  conn.value.close();
});
