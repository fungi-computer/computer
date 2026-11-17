import { readFileSync } from "node:fs";
import process from "node:process";
import { createRequire } from "node:module";
const loadNative = createRequire(import.meta.url);

/** @returns {"contained" | "vm-sudo"} */
export function readRuntimePrivilegeMode(
  marker = "/etc/fungi/runtime-privilege-mode",
) {
  let mode;
  try {
    mode = readFileSync(marker, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "contained";
    throw error;
  }
  if (mode !== "contained" && mode !== "vm-sudo")
    throw new Error("Invalid Computer runtime privilege mode");
  return mode;
}

export function enterRuntimePhase() {
  const uid = Number(process.env.COMPUTER_RUNTIME_UID);
  if (!Number.isSafeInteger(uid) || uid < 100_000 || uid > 2_000_099_999)
    throw new Error("Invalid Computer runtime UID");
  loadNative("./runtime-privileges.node").enterRuntimePhase(
    uid,
    readRuntimePrivilegeMode() === "contained",
  );
}
