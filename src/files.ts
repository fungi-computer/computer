import type {
  SQLiteWorkspaceProvider,
  WorkspaceClient,
} from "@fungi.computer/cloudflare-computer";
import { posix } from "node:path";
import { z } from "zod";
import { SearchVisibility } from "@fungi.computer/knapsack/files-search";

/** Files need only the Workspace filesystem, local or leased through a stub. */
export type WorkspaceFiles = Pick<WorkspaceClient, "fs">;
import type { FilesPort } from "@fungi.computer/knapsack";
import {
  imageReadResult,
  imageSniffBytes,
  imageTooLargeMessage,
  maximumImageBytes,
  sniffImageMimeType,
} from "@fungi.computer/knapsack/files-read";
import {
  replaceOutputSchema,
  type ComputerFileGlobInput,
  type ComputerFileGrepInput,
  type ComputerFileListInput,
  type ComputerFileReplacement,
  type ComputerFileReplacementResult,
} from "@fungi.computer/computer-contract";
const utf8 = new TextEncoder();

type GrepOptions = NonNullable<Parameters<WorkspaceFiles["fs"]["grep"]>[2]>;

export type WorkspaceFilesOwner = Readonly<{
  replaceFileIfUnchanged: (
    input: ComputerFileReplacement,
  ) => Promise<ComputerFileReplacementResult>;
}>;

export type Utf8Page = Readonly<{ content: string; byteLength: number }>;
type ByteReadOptions = Readonly<{
  byteOffset: number;
  byteLength: number;
}>;

function entryType(entry: {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}): "file" | "directory" | "symlink" {
  if (entry.isSymbolicLink) return "symlink";
  if (entry.isFile) return "file";
  if (entry.isDirectory) return "directory";
  return "symlink";
}

function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  return decodeUtf8Page(bytes, path, false).content;
}

/** Decode a bounded byte page without consuming an incomplete final UTF-8 character. */
export function decodeUtf8Page(
  bytes: Uint8Array,
  path: string,
  moreBytesRemain: boolean,
): Utf8Page {
  try {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes, { stream: moreBytesRemain });
    const byteLength = utf8.encode(content).byteLength;
    if (byteLength === 0 && bytes.byteLength > 0) {
      throw new Error(`Files read cannot advance a UTF-8 page: ${path}`);
    }
    return { content, byteLength };
  } catch (cause) {
    throw new Error(`Files path is not valid UTF-8: ${path}`, { cause });
  }
}

async function readBytes(
  workspace: WorkspaceFiles,
  path: string,
  byteOffset: number,
  byteLength: number,
): Promise<Uint8Array> {
  const options: ByteReadOptions = {
    byteOffset,
    byteLength,
  };
  const source = await workspace.fs.readFile(path, options);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/** Read raw bounded bytes without Workspace.fs's BOM-stripping UTF-8 path. */
export function readBoundedWorkspaceText(
  provider: SQLiteWorkspaceProvider,
  path: string,
  maximumBytes: number,
): string {
  const stat = provider.statSync(path);
  if (!stat.isFile()) throw new Error(`Files path is not a file: ${path}`);
  if (stat.size > maximumBytes) {
    throw new Error(
      `Files path exceeds the ${String(maximumBytes)}-byte bound: ${path}`,
    );
  }
  return decodeUtf8(
    new Uint8Array(provider.readRangeSync(path, 0, stat.size)),
    path,
  );
}

/** Adapt native Workspace.fs at the one real file boundary. */
export function createWorkspaceFilesPort(
  workspace: WorkspaceFiles,
  owner: WorkspaceFilesOwner,
) {
  const port = {
    async read(input) {
      const stat = await workspace.fs.stat(input.path);
      if (!stat.isFile)
        throw new Error(`Files path is not a file: ${input.path}`);
      if (input.offset > stat.size) {
        throw new Error(`Files read offset exceeds file size: ${input.path}`);
      }
      if (input.offset === stat.size) {
        return {
          path: input.path,
          content: "",
          offset: input.offset,
          nextOffset: null,
          truncated: false,
        };
      }
      // The first read covers the sniff window whatever the caller's limit.
      const windowBytes = await readBytes(
        workspace,
        input.path,
        input.offset,
        Math.min(
          input.offset === 0
            ? Math.max(input.limit, imageSniffBytes)
            : input.limit,
          stat.size - input.offset,
        ),
      );
      if (windowBytes.byteLength === 0) {
        throw new Error(`Files path changed during read: ${input.path}`);
      }
      const mimeType =
        input.offset === 0 ? sniffImageMimeType(windowBytes) : undefined;
      if (mimeType !== undefined) {
        if (stat.size > maximumImageBytes)
          throw new Error(
            imageTooLargeMessage(input.path, stat.size, maximumImageBytes),
          );
        return imageReadResult(
          input.path,
          mimeType,
          windowBytes.byteLength === stat.size
            ? windowBytes
            : await readBytes(workspace, input.path, 0, stat.size),
        );
      }
      const pageBytes = windowBytes.subarray(0, input.limit);
      const page = decodeUtf8Page(
        pageBytes,
        input.path,
        input.offset + pageBytes.byteLength < stat.size,
      );
      const nextOffset = input.offset + page.byteLength;
      return {
        path: input.path,
        content: page.content,
        offset: input.offset,
        nextOffset: nextOffset < stat.size ? nextOffset : null,
        truncated: nextOffset < stat.size,
      };
    },
    async list(input, context?: Parameters<FilesPort["list"]>[1]) {
      const output = await searchWorkspaceDirectory(
        workspace,
        { ...input, offset: 0 },
        context?.signal,
      );
      return {
        path: input.path,
        ...output,
        results: output.results.map((entry) => ({
          path: entry.path,
          type: entryType(entry),
        })),
      };
    },
    async glob(input, context?: Parameters<FilesPort["glob"]>[1]) {
      const output = await visibleSearch(
        workspace,
        workspacePath(input.path),
        input.limit,
        (options) =>
          workspace.fs.find(workspacePath(input.path), input.pattern, options),
        (entry) => entry.type === "dir",
        context?.signal,
      );
      return {
        path: input.path,
        ...output,
        results: output.results.map((row) => ({
          path: row.path,
          type: row.type === "dir" ? "directory" : "file",
        })),
      };
    },
    async grep(input, context?: Parameters<FilesPort["grep"]>[1]) {
      const options: GrepOptions = {
        regex: input.regex,
        ignoreCase: input.ignoreCase,
        limit: input.limit + 1,
      };
      if (input.include !== undefined) options.include = input.include;
      const output = await visibleSearch(
        workspace,
        workspacePath(input.path),
        input.limit,
        (page) =>
          workspace.fs.grep(input.pattern, workspacePath(input.path), {
            ...options,
            ...page,
          }),
        () => false,
        context?.signal,
      );
      return {
        path: input.path,
        ...output,
        results: output.results.map((row) => ({
          path: row.path,
          line: row.line,
          text: row.text,
        })),
      };
    },
    async replace(input) {
      return replaceOutputSchema.parse(
        await owner.replaceFileIfUnchanged(input),
      );
    },
  } satisfies FilesPort;
  return Object.freeze({
    ...port,
    // The Computer REST contract keeps its own path and content searches for
    // Apps and Hub routes; its matches/boolean results are not Agent results.
    rest: Object.freeze({
      list: (input: ComputerFileListInput) =>
        listWorkspaceFiles(workspace, input),
      async glob(input: ComputerFileGlobInput) {
        const output = await port.glob(input);
        return {
          path: input.path,
          matches: output.results.map((entry) => entry.path),
          truncated: output.truncated !== null,
        };
      },
      async grep(input: ComputerFileGrepInput) {
        const output = await port.grep(input);
        return {
          path: input.path,
          matches: output.results,
          truncated: output.truncated !== null,
        };
      },
    }),
  });
}

function searchWorkspaceDirectory(
  workspace: WorkspaceFiles,
  input: ComputerFileListInput,
  signal?: AbortSignal,
) {
  const path = workspacePath(input.path);
  return visibleSearch(
    workspace,
    path,
    input.limit,
    async (options) =>
      (await workspace.fs.readdir(path, options)).map((entry) => ({
        ...entry,
        path: childPath(path, entry.name),
      })),
    (entry) => entry.isDirectory,
    signal,
    input.offset,
  );
}

/** Shared REST listing: offsets count visible entries, never ignored candidates. */
export async function listWorkspaceFiles(
  workspace: WorkspaceFiles,
  input: ComputerFileListInput,
) {
  const output = await searchWorkspaceDirectory(workspace, input);
  // The existing list wire has no scan-reason field. Do not disguise an
  // exhausted scan as an empty finished page or a fabricated next offset.
  if (output.truncated === "scan")
    throw new Error("Files listing reached the search scan bound; narrow path");
  return {
    path: input.path,
    entries: output.results.map((entry) => ({
      name: entry.name,
      size: entry.size,
      modifiedAt: entry.mtime,
      type: entryType(entry),
    })),
    nextOffset:
      output.truncated === null ? null : input.offset + output.results.length,
  };
}

/** Computer wire paths are absolute within its Workspace, even for relative Files inputs. */
function workspacePath(path: string): string {
  if (path === ".") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

const missingSchema = z.object({ code: z.literal("ENOENT") });

/** A regular file's stat, or null when the path is absent or not a file. */
async function fileStat(
  workspace: WorkspaceFiles,
  path: string,
): Promise<{ size: number } | null> {
  try {
    const stat = await workspace.fs.stat(path);
    return stat.isFile ? stat : null;
  } catch (error) {
    if (missingSchema.safeParse(error).success) return null;
    throw error;
  }
}

/** Storage adapter only; shared Files policy owns visibility and grammar. */
function workspaceSearchVisibility(
  workspace: WorkspaceFiles,
): SearchVisibility {
  let bytes = 0;
  return new SearchVisibility(async (directory) => {
    const path = posix.join("/", directory, ".gitignore");
    const stat = await fileStat(workspace, path);
    if (stat !== null) {
      // Match Local's bounded text reads; never silently omit unreadable rules.
      if (stat.size > 128 * 1_024 || bytes + stat.size > 64 * 1_024 * 1_024)
        throw new Error(
          `Files ignore rules exceed the search byte bound: ${path}`,
        );
      bytes += stat.size;
      return decodeUtf8(await readBytes(workspace, path, 0, stat.size), path);
    }
    return undefined;
  });
}

function searchRelativePath(path: string): string {
  return posix.relative("/", posix.resolve("/", path));
}

/** Page the SDK's traversal; filtering must not spend the visible-result limit. */
async function visibleSearch<Row extends { path: string }>(
  workspace: WorkspaceFiles,
  root: string,
  limit: number,
  page: (options: { limit: number; offset?: number }) => Promise<Row[]>,
  isDirectory: (row: Row) => boolean,
  signal?: AbortSignal,
  visibleOffset = 0,
): Promise<{ results: Row[]; truncated: "limit" | "scan" | null }> {
  const rules = workspaceSearchVisibility(workspace);
  const results: Row[] = [];
  signal?.throwIfAborted();
  const metadata = await workspace.fs.stat(root);
  if (!(await rules.visible(searchRelativePath(root), metadata.isDirectory)))
    return { results, truncated: null };
  const maximumCandidates = 50_000;
  let offset = 0;
  while (offset < maximumCandidates) {
    signal?.throwIfAborted();
    const count = Math.min(
      offset === 0 ? limit + 1 : Math.max(128, limit + 1),
      maximumCandidates - offset,
    );
    const rows = await page(
      offset === 0 ? { limit: count } : { limit: count, offset },
    );
    for (const row of rows) {
      signal?.throwIfAborted();
      if (
        !(await rules.visible(searchRelativePath(row.path), isDirectory(row)))
      )
        continue;
      if (visibleOffset > 0) {
        visibleOffset--;
        continue;
      }
      if (results.length === limit) return { results, truncated: "limit" };
      results.push(row);
    }
    if (rows.length < count) return { results, truncated: null };
    offset += rows.length;
  }
  return { results, truncated: "scan" };
}
