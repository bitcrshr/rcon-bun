import { RCONConnection } from ".";

export * from "./packet";
export * from "./rcon";

const host = process.env.RCON_HOST!;
const port = process.env.RCON_PORT!;
const password = process.env.RCON_PASSWORD!;

const conn = await RCONConnection.dial(host, port, password);
if (conn.isErr) {
  console.error(conn.error);
  throw conn.error;
}

const res = await conn.value.execute("ping");
if (res.isErr) {
  console.error(res.error);
  throw res.error;
}

console.log(res.value);

conn.value.close();
