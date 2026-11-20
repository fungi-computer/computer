# node-pty ships no Linux prebuild; compile it against the runtime's Node ABI.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600 AS terminal
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config libfuse-dev \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-fund --no-audit pnpm@11.24.0
WORKDIR /opt/fungi
COPY container/package.json container/pnpm-lock.yaml container/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --config.node-linker=hoisted \
  && cd node_modules/node-pty \
  && mv build/Release/pty.node /tmp/pty.node \
  && rm -rf build deps third_party src scripts typings prebuilds node-addon-api \
  && mkdir -p build/Release \
  && mv /tmp/pty.node build/Release/pty.node \
  && chmod -R a+rX /opt/fungi/node_modules

COPY container/runtime-privileges.cc ./
RUN g++ -shared -fPIC -I/usr/local/include/node runtime-privileges.cc -o runtime-privileges.node

# Compile Cordyceps' native apply-patch engine (source copied into
# dist/apply-patch by this package's build) for this image's own platform.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600 AS apply-patch
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:$PATH
COPY dist/apply-patch/pin.mjs /source/
RUN toolchain="$(node --input-type=module --eval "import { codexPatchPin } from '/source/pin.mjs'; console.log(codexPatchPin.rustToolchain)")" \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
  && sh /tmp/rustup.sh -y --profile minimal --default-toolchain "$toolchain" \
  && rm /tmp/rustup.sh
COPY dist/apply-patch/ /source/
RUN node /source/compile.mjs --out /out --scratch /scratch

# Only uv ships by default; fungi-tools installs optional pinned tools at first use.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600 AS tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/downloads
RUN curl -fLSs https://github.com/astral-sh/uv/releases/download/0.13.8/uv-x86_64-unknown-linux-gnu.tar.gz -o uv.tar.gz \
  && echo '5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91  uv.tar.gz' | sha256sum -c - \
  && mkdir -p /opt/toolchains/uv && tar -xzf uv.tar.gz -C /opt/toolchains/uv --strip-components=1 \
  && chmod -R a+rX /opt/toolchains

# Match the repository toolchain on the same Linux x64 target as computerd.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fuse3 libfuse2t64 ca-certificates curl git procps s6 tini openssh-server \
    python3 python3-venv gcc libc6-dev gh ripgrep xz-utils \
  && rm -f /etc/ssh/ssh_host_* \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-fund --no-audit pnpm@11.24.0 \
  && test "$(node --version)" = "v24.20.0" \
  && test "$(pnpm --version)" = "11.24.0"

# Build contexts may come from private gate checkouts (umask 077). Runtime
# modules must remain readable after init drops to the Computer's own UID.
# dist/computerd.cjs comes from this package's own build, which copies it from
# @fungi.computer/cordyceps; the apply-patch engine and its crate notices come
# from the builder stage above. The image assembly step
# (scripts/assemble-image.mjs, also run by prepack) copies Oyster's App
# candidate builder into dist/ before this Dockerfile is built.
COPY dist/computerd.cjs dist/team-candidate-builder.mjs /opt/fungi/
COPY --from=apply-patch --chmod=755 /out/fungi-apply-patch /opt/fungi/fungi-apply-patch
COPY --from=apply-patch /out/build.json /opt/fungi/fungi-apply-patch.notices.json
COPY dist/apply-patch/LICENSE.codex /opt/fungi/fungi-apply-patch.LICENSE
COPY --from=tools /opt/toolchains /opt/toolchains
RUN ln -s /opt/toolchains/uv/uv /opt/toolchains/uv/uvx /usr/local/bin/
COPY container/tools/ /opt/fungi/tools/
COPY --chmod=755 container/tools/fungi-tools /usr/local/bin/fungi-tools
COPY --chmod=755 container/fungi-services /usr/local/bin/fungi-services
COPY container/runtime-privileges.mjs /opt/fungi/
COPY --from=terminal /opt/fungi/runtime-privileges.node /opt/fungi/
COPY --from=terminal /opt/fungi/node_modules /opt/fungi/node_modules
COPY container/package.json container/computer-init.mjs container/computer-start.sh container/fungi-services.mjs container/services-render.mjs container/resource-bounds.mjs container/terminal-server.mjs container/terminal-runtime.mjs container/terminal-protocol.mjs container/sshd_config /opt/fungi/
COPY container/terminal-assets/bashrc container/terminal-assets/git-prompt.sh container/terminal-assets/global-tools.sh /opt/fungi/terminal-assets/
RUN chmod -R a+rX /opt/fungi \
  && printf '\n. /opt/fungi/terminal-assets/bashrc\n' >> /etc/bash.bashrc \
  && printf '. /opt/fungi/terminal-assets/global-tools.sh\n. /opt/fungi/terminal-assets/bashrc\n' > /etc/profile.d/fungi-terminal.sh

# openssh-server is installed only for `sshd -i`, which terminal-server.mjs runs
# as the runtime user for one admitted connection. No sshd service starts, and no
# host key ships in the image: vmd supplies each VM's key at boot.
# No customer process can invoke a setuid/setgid helper, including fusermount.
# FUSE is mounted while init is root, before either runtime listener opens.
RUN find / -xdev -perm /6000 -exec chmod a-s {} +

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
ENV COMPUTER_TERMINAL_PORT=7681
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
ENV SSL_CERT_FILE=/tmp/fungi-ca-bundle.crt
ENV GIT_SSL_CAINFO=/tmp/fungi-ca-bundle.crt
EXPOSE 8080 7681

# tini is PID 1 and only reaps orphans and forwards signals. computer-init is
# the one supervisor: it owns computerd and the terminal server, and exits
# with them so the Containers runtime replaces the whole Computer runtime.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["/usr/bin/bash", "/opt/fungi/computer-start.sh"]
