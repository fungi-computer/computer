// This process is exec'd only after init permanently drops its credentials.
import process from "node:process";
import { startTerminalServer } from "./terminal-server.mjs";
const terminal = startTerminalServer(
  Number(process.env.COMPUTER_TERMINAL_PORT ?? "7681"),
);
await terminal.listening;
process.send?.({ type: "terminal-ready" });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => terminal.close());
