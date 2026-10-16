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
  && mv /tmp/pty.node build/Release/pty.node

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

# Match the repository toolchain on the same Linux x64 target as computerd.
FROM node:24.20.0-trixie-slim@sha256:a747ad80c8a161b650d79a6da9c422005b91148b18b8d2c669eb5a0b7c07e600

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fuse3 libfuse2t64 ca-certificates curl git tini \
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
COPY --from=terminal /opt/fungi/node_modules /opt/fungi/node_modules
COPY container/runtime-privileges.mjs /opt/fungi/
COPY --from=terminal /opt/fungi/runtime-privileges.node /opt/fungi/
COPY container/package.json container/computer-init.mjs container/computer-start.sh container/resource-bounds.mjs container/terminal-server.mjs container/terminal-runtime.mjs container/terminal-protocol.mjs /opt/fungi/
COPY container/terminal-assets/bashrc container/terminal-assets/git-prompt.sh /opt/fungi/terminal-assets/
RUN chmod -R a+rX /opt/fungi \
  && printf '\n. /opt/fungi/terminal-assets/bashrc\n' >> /etc/bash.bashrc \
  && printf '. /opt/fungi/terminal-assets/bashrc\n' > /etc/profile.d/fungi-terminal.sh

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
