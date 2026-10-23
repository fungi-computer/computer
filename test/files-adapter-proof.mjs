/* global Buffer, ReadableStream, TextEncoder, console */

import assert from "node:assert/strict";

import { createWorkspaceFilesPort } from "../dist/files.js";

const calls = [];
const text = new TextEncoder();
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const bytesAt = (path) => (path === "/shot.png" ? png : text.encode("hello"));
const files = {
  async stat(path) {
    if (path.endsWith("/.gitignore")) {
      throw Object.assign(new Error("No ignore file"), { code: "ENOENT" });
    }
    calls.push(["stat", path]);
    return {
      isFile: path !== "/",
      isDirectory: path === "/",
      size: bytesAt(path).byteLength,
    };
  },
  async readFile(path, options) {
    calls.push(["readFile", path, options]);
    const bytes = bytesAt(path);
    const start = options.byteOffset ?? 0;
    const end = start + (options.byteLength ?? bytes.byteLength);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(start, end));
        controller.close();
      },
    });
  },
  async readdir(path, options) {
    calls.push(["readdir", path, options]);
    return [
      {
        name: "a.txt",
        size: 5,
        mtime: 1,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
      {
        name: "b.txt",
        size: 5,
        mtime: 2,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      },
    ];
  },
  async find(path, pattern, options) {
    calls.push(["find", path, pattern, options]);
    return [
      { path: "/a.txt", type: "file" },
      { path: "/b.txt", type: "file" },
    ];
  },
  async grep(pattern, path, options) {
    calls.push(["grep", pattern, path, options]);
    return [
      { path: "/a.txt", line: 1, text: "hello" },
      { path: "/b.txt", line: 2, text: "hello" },
    ];
  },
};

const owner = {
  async replaceFileIfUnchanged(input) {
    calls.push(["replaceFileIfUnchanged", input]);
    return {
      path: input.path,
      bytes: text.encode(input.content).byteLength,
    };
  },
};

const port = createWorkspaceFilesPort({ fs: files }, owner);
assert.deepEqual(await port.read({ path: "/hello.txt", offset: 0, limit: 4 }), {
  path: "/hello.txt",
  content: "hell",
  offset: 0,
  nextOffset: 4,
  truncated: true,
});
assert.deepEqual(await port.read({ path: "/shot.png", offset: 0, limit: 4 }), {
  path: "/shot.png",
  image: {
    mimeType: "image/png",
    data: Buffer.from(png).toString("base64"),
    bytes: png.byteLength,
  },
});
assert.deepEqual(await port.list({ path: ".", limit: 1 }), {
  path: ".",
  results: [{ path: "/a.txt", type: "file" }],
  truncated: "limit",
});
assert.deepEqual(
  await port.glob({
    path: "/",
    pattern: "*.txt",
    limit: 1,
  }),
  {
    path: "/",
    results: [{ path: "/a.txt", type: "file" }],
    truncated: "limit",
  },
);
assert.deepEqual(
  await port.grep({
    path: "/",
    include: "*.txt",
    pattern: "hello",
    regex: false,
    ignoreCase: false,
    limit: 1,
  }),
  {
    path: "/",
    results: [{ path: "/a.txt", line: 1, text: "hello" }],
    truncated: "limit",
  },
);
assert.deepEqual(
  await port.rest.glob({ path: "/", pattern: "*.txt", limit: 1 }),
  {
    path: "/",
    matches: ["/a.txt"],
    truncated: true,
  },
);
assert.deepEqual(
  await port.rest.grep({
    path: "/",
    pattern: "hello",
    regex: false,
    ignoreCase: false,
    limit: 1,
  }),
  {
    path: "/",
    matches: [{ path: "/a.txt", line: 1, text: "hello" }],
    truncated: true,
  },
);
// Agent visibility is independent of the SDK's unfiltered search results.
const ignoredFiles = {
  ...files,
  async stat(path) {
    return {
      isFile: path !== "/",
      isDirectory: path === "/",
      size: text.encode("node_modules/\n").byteLength,
    };
  },
  async readFile() {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(text.encode("node_modules/\n"));
        controller.close();
      },
    });
  },
  async find() {
    return [
      { path: "/.git/config", type: "file" },
      { path: "/node_modules/x.js", type: "file" },
    ];
  },
};
assert.deepEqual(
  await createWorkspaceFilesPort({ fs: ignoredFiles }, owner).glob({
    path: "/",
    pattern: "*",
    limit: 5,
  }),
  {
    path: "/",
    results: [],
    truncated: null,
  },
);
assert.deepEqual(
  await port.replace({
    path: "/hello.txt",
    expectedContent: "hello",
    content: "updated",
  }),
  { path: "/hello.txt", bytes: 7 },
);
assert.deepEqual(calls, [
  ["stat", "/hello.txt"],
  ["readFile", "/hello.txt", { byteOffset: 0, byteLength: 5 }],
  ["stat", "/shot.png"],
  ["readFile", "/shot.png", { byteOffset: 0, byteLength: 8 }],
  ["stat", "/"],
  ["readdir", "/", { limit: 2 }],
  ["stat", "/"],
  ["find", "/", "*.txt", { limit: 2 }],
  ["stat", "/"],
  [
    "grep",
    "hello",
    "/",
    { regex: false, ignoreCase: false, limit: 2, include: "*.txt" },
  ],
  ["stat", "/"],
  ["find", "/", "*.txt", { limit: 2 }],
  ["stat", "/"],
  ["grep", "hello", "/", { regex: false, ignoreCase: false, limit: 2 }],
  [
    "replaceFileIfUnchanged",
    {
      path: "/hello.txt",
      expectedContent: "hello",
      content: "updated",
    },
  ],
]);

console.log("Computer Workspace Files adapter translation proof passed");
