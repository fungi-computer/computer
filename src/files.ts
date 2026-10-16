import type {
  SQLiteWorkspaceProvider,
  WorkspaceClient,
} from "@fungi.computer/cloudflare-computer";

/** Files need only the Workspace filesystem, local or leased through a stub. */
export type WorkspaceFiles = Pick<WorkspaceClient, "fs">;
import type { FilesPort } from "@fungi.computer/knapsack";
import {
  replaceOutputSchema,
  type ComputerFileReplacement,
  type ComputerFileReplacementResult,
} from "./operation-contract.js";
const utf8 = new TextEncoder();

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
  return Object.freeze({
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
      const pageBytes = await readBytes(
        workspace,
        input.path,
        input.offset,
        Math.min(input.limit, stat.size - input.offset),
      );
      if (pageBytes.byteLength === 0) {
        throw new Error(`Files path changed during read: ${input.path}`);
      }
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
    async list(input) {
      const rows = await workspace.fs.readdir(input.path, {
        limit: input.limit + 1,
      });
      const entries = rows.slice(0, input.limit).map((entry) => {
        const path = childPath(input.path, entry.name);
        return {
          path,
          name: entry.name,
          type: entryType(entry),
          size: entry.size,
          modifiedAt: entry.mtime,
        };
      });
      return {
        path: input.path,
        entries,
        truncated: rows.length > input.limit,
      };
    },
    async glob(input) {
      const rows = await workspace.fs.find(input.path, input.pattern, {
        limit: input.limit + 1,
      });
      return {
        path: input.path,
        matches: rows.slice(0, input.limit).map((entry) => entry.path),
        truncated: rows.length > input.limit,
      };
    },
    async grep(input) {
      const rows = await workspace.fs.grep(input.pattern, input.path, {
        regex: input.regex,
        ignoreCase: input.ignoreCase,
        limit: input.limit + 1,
      });
      return {
        path: input.path,
        matches: rows.slice(0, input.limit).map((row) => ({
          path: row.path,
          line: row.line,
          text: row.text,
        })),
        truncated: rows.length > input.limit,
      };
    },
    async replace(input) {
      return replaceOutputSchema.parse(
        await owner.replaceFileIfUnchanged(input),
      );
    },
  } satisfies FilesPort);
}
