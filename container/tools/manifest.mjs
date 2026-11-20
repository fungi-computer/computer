// Reviewed Linux x64 artifacts from #951. Downloads are never selected by
// caller-supplied URLs or a mutable "latest" endpoint.
export const toolCatalog = {
  go: {
    title: "Go",
    persistence: "home",
    version: "1.27.4",
    archives: [
      {
        url: "https://go.dev/dl/go1.27.4.linux-amd64.tar.gz",
        algorithm: "sha256",
        digest:
          "7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840",
        strip: 1,
      },
    ],
    bins: { go: "bin/go", gofmt: "bin/gofmt" },
  },
  rust: {
    title: "Rust",
    persistence: "home",
    version: "1.100.0",
    recipe: "rust",
    archives: [
      {
        url: "https://static.rust-lang.org/dist/2026-11-12/rustc-1.100.0-x86_64-unknown-linux-gnu.tar.xz",
        algorithm: "sha256",
        digest:
          "f1d0b1dec81dab6f523cd098507763487b0d4bd7fd2c87582f154128719be03b",
        strip: 1,
      },
      {
        url: "https://static.rust-lang.org/dist/2026-11-12/cargo-1.100.0-x86_64-unknown-linux-gnu.tar.xz",
        algorithm: "sha256",
        digest:
          "7e29ce07d7c6e92d1826870575ba27d57fff6cb3e754aa57d99099cb88fab35d",
        strip: 1,
      },
      {
        url: "https://static.rust-lang.org/dist/2026-11-12/rust-std-1.100.0-x86_64-unknown-linux-gnu.tar.xz",
        algorithm: "sha256",
        digest:
          "4591b6486594ded52ecd6135db95bf9355bbd3ca7a380888b141528bbcf9a5d4",
        strip: 1,
      },
    ],
    bins: { rustc: "bin/rustc", rustdoc: "bin/rustdoc", cargo: "bin/cargo" },
  },
  claude: {
    title: "Claude Code",
    persistence: "cache",
    version: "2.1.325",
    archives: [
      {
        url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.325.tgz",
        algorithm: "sha512",
        digest:
          "06a67332f3ffce02cb2f7e12fbb3b36c6f9cca8169ee0c161d4e64a15c2cc8c953033fb4cd90266d8f94933bed376457c69e8070c7a76d8223409c685df518df",
        strip: 1,
      },
    ],
    bins: { claude: "claude" },
  },
  codex: {
    title: "Codex",
    persistence: "cache",
    version: "0.169.0",
    archives: [
      {
        url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-x64.tgz",
        algorithm: "sha512",
        digest:
          "a34e4dc803820f28123d1a35ca29f3c6f91149d9ac672043f44ee66e99a345a9d27ccf25ca9a96b50804a385df364c21b82476685bbc9a518eb101855d56d5c3",
        strip: 1,
      },
      {
        url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0.tgz",
        algorithm: "sha512",
        digest:
          "2a1cd896428fc6836cb11f02126e39223aa71569fb52d945e02883ded3893de6b9d7106cecc687cb45101bd1926c2aa4e8bae39f941d243574403d7f1605a51b",
        strip: 1,
      },
    ],
    bins: { codex: "bin/codex.js" },
  },
  opencode: {
    title: "OpenCode",
    persistence: "cache",
    version: "2.3.0",
    archives: [
      {
        url: "https://registry.npmjs.org/@opencode/cli-linux-x64-baseline/-/cli-linux-x64-baseline-2.3.0.tgz",
        algorithm: "sha512",
        digest:
          "c08328f5a9d42485659c126518cd2507b9fe8e614cb2d4708cde8bc3cfacd21a7e1e903de0b9953030e44e0fa242acdcb1ab6525a1eb7b7f6ff31fa319012b45",
        strip: 1,
      },
    ],
    bins: { opencode: "bin/opencode" },
  },
  pi: {
    title: "pi",
    persistence: "cache",
    version: "1.5.2",
    recipe: "pnpm",
    archives: [],
    bins: {
      pi: "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    },
  },
};
