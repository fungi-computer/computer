import process from "node:process";
import { createRequire } from "node:module";
const loadNative = createRequire(import.meta.url);
const native = loadNative("./runtime-privileges.node");

export function enterRuntimePhase() {
  const uid = Number(process.env.COMPUTER_RUNTIME_UID);
  if (!Number.isSafeInteger(uid) || uid < 100_000 || uid > 2_000_099_999)
    throw new Error("Invalid Computer runtime UID");
  native.enterRuntimePhase(uid);
}
