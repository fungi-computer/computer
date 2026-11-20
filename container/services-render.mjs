// Renders declared services into s6 service directories. Pure: it decides the
// files and the supervisor commands, and touches neither the disk nor s6.
import { z } from "zod";

/** The JSON the Computer sends `fungi-services apply`; the contract's declaration, closed. */
export const applyInputSchema = z.strictObject({
  services: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u),
        command: z.string().min(1).max(16_384),
        cwd: z
          .string()
          .min(1)
          .max(4_096)
          .startsWith("/")
          .refine((path) => !path.includes("\0"))
          .optional(),
        env: z
          .record(
            z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u),
            z.string().max(4_096),
          )
          .refine((env) => Object.keys(env).length <= 32)
          .optional(),
        enabled: z.boolean(),
      }),
    )
    .max(16),
});

/** One POSIX shell word: single-quoted, so `'`, `$`, backticks and newlines stay literal. */
export function shellWord(text) {
  if (text.includes("\0"))
    throw new Error("A shell word cannot hold a NUL byte");
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * The files of one service: its `run`, its logger's `run` and the `down`
 * marker when stopped.
 */
export function renderService(service, { workspace, logRoot }) {
  const env = Object.entries(service.env ?? {}).map(
    ([key, value]) => `export ${key}=${shellWord(value)}\n`,
  );
  const run = [
    "#!/bin/sh\n",
    "exec 2>&1\n",
    `cd ${shellWord(service.cwd ?? workspace)} || exit 1\n`,
    ...env,
    // s6 signals only this script. The command runs beside it in the service's
    // own process group, so a stop or restart ends everything it started, not
    // just its shell.
    `/bin/sh -c ${shellWord(service.command)} &\n`,
    "child=$!\n",
    "trap 'kill -TERM 0 2>/dev/null' TERM INT\n",
    'wait "$child"\n',
    "status=$?\n",
    'while kill -0 "$child" 2>/dev/null; do wait "$child"; status=$?; done\n',
    'exit "$status"\n',
  ].join("");
  const logger = [
    "#!/bin/sh\n",
    // Five files of about a megabyte each, newest kept.
    `exec s6-log n5 s1000000 ${shellWord(`${logRoot}/${service.name}`)}\n`,
  ].join("");
  return {
    run,
    logRun: logger,
    down: service.enabled ? null : "",
  };
}

/**
 * What to do to reach the declared set. `existing` maps each service directory
 * now in the scan directory to its current `run` text. A directory the supervisor
 * has not seen yet starts itself (or stays down), so only a directory that
 * already has a supervisor needs a control command: restart when its run file
 * changed (up and TERM, which also starts a stopped one), up when it should run,
 * down when it should not.
 */
export function planApply(input, existing, options) {
  const declared = new Map();
  for (const service of input.services)
    declared.set(service.name, {
      service,
      files: renderService(service, options),
    });
  const write = [];
  const control = [];
  const remove = [];
  for (const [name, { service, files }] of declared) {
    write.push({ name, ...files });
    const current = existing.get(name);
    if (current === undefined) continue;
    if (!service.enabled) control.push({ name, command: "-d" });
    else if (current !== files.run) control.push({ name, command: "-ut" });
    else control.push({ name, command: "-u" });
  }
  for (const name of existing.keys())
    if (!declared.has(name)) remove.push(name);
  return { write, control, remove };
}

/**
 * `s6-svstat -o up,wantedup,pid,updownfor` prints its values on one line,
 * with no pid while the service is down. A service that is down but wanted up
 * is between restarts; one that is down and not wanted is stopped.
 */
export function parseSvstat(text) {
  const values = text.trim().split(/\s+/u);
  const seconds = Number(values.at(-1));
  if (values[0] === "true" && values.length === 4)
    return { state: "up", pid: Number(values[2]), seconds };
  if (values[0] === "false" && values.length >= 3)
    return { state: values[1] === "true" ? "restarting" : "down", seconds };
  throw new Error(`Unreadable s6-svstat output: ${text.slice(0, 80)}`);
}

/** The last `lines` lines of s6-log's `current` file, and whether older lines were cut. */
export function tailLog(text, lines) {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return { lines: all.slice(-lines), truncated: all.length > lines };
}
