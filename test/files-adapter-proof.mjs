/* global ReadableStream, TextEncoder, console */

import assert from "node:assert/strict";

import { createWorkspaceFilesPort } from "../dist/files.js";

const calls = [];
const text = new TextEncoder();
const files = {
  async stat(path) {
    calls.push(["stat", path]);
    return { isFile: true, size: 5 };
  },
  async readFile(path, options) {
    calls.push(["readFile", path, options]);
    const bytes = text.encode("hello");
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
assert.deepEqual(await port.list({ path: "/", limit: 1 }), {
  path: "/",
  entries: [
    {
      path: "/a.txt",
      name: "a.txt",
      type: "file",
      size: 5,
      modifiedAt: 1,
    },
  ],
  truncated: true,
});
assert.deepEqual(await port.glob({ path: "/", pattern: "*.txt", limit: 1 }), {
  path: "/",
  matches: ["/a.txt"],
  truncated: true,
});
assert.deepEqual(
  await port.grep({
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
  ["readFile", "/hello.txt", { byteOffset: 0, byteLength: 4 }],
  ["readdir", "/", { limit: 2 }],
  ["find", "/", "*.txt", { limit: 2 }],
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
