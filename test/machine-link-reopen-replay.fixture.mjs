/* global Request */
import process from "node:process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { seamHeader } from "@fungi.computer/seam";
import { verifyLocalBackendDial } from "../dist/local-backend.js";

let text = "";
for await (const chunk of process.stdin) text += chunk;
const dial = JSON.parse(text);
const database = new DatabaseSync(
  resolve(process.env.COMPUTER_DIAL_REPLAY_STATE, "local-dial.sqlite"),
);
try {
  const owner = fromNodeSqlite(database);
  const admit = () =>
    verifyLocalBackendDial(
      new Request(dial.url, {
        method: "GET",
        headers: { [seamHeader]: dial.header },
      }),
      dial.computerName,
      dial.backend,
      owner,
    );
  process.stdout.write(
    JSON.stringify({
      pid: process.pid,
      first: await admit(),
      warmReplay: await admit(),
    }),
  );
} finally {
  database.close();
}
