# The named forage context contains the unchanged tracked package.json.
# The ordinary build context contains pnpm's generated standalone lockfile.
ARG COMPUTER_IMAGE=botanical-computer-dogfood:2ff54dd
FROM ${COMPUTER_IMAGE}

ARG FORAGE_SOURCE_REVISION
ARG FORAGE_SOURCE_MANIFEST_SHA256
ARG FORAGE_DEPENDENCY_RECIPE_SHA256
LABEL org.botanical.forage.source-revision=${FORAGE_SOURCE_REVISION} \
  org.botanical.forage.source-manifest-sha256=${FORAGE_SOURCE_MANIFEST_SHA256} \
  org.botanical.forage.dependency-recipe-sha256=${FORAGE_DEPENDENCY_RECIPE_SHA256}

WORKDIR /opt/forage-dependencies
COPY --from=forage package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
# pnpm's offline policy checks also need registry metadata, not just tarballs.
# Keep both seeds outside /root so an unprivileged Computer can copy them.
RUN pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts \
    --store-dir /opt/pnpm-store --cache-dir /opt/pnpm-cache \
  && rm -rf node_modules

# Source and build outputs are supplied at run time under the durable mount.
# This image carries dependencies, never a prebuilt Forage dist.
# The native proof copies the store and cache into /tmp before installing.
WORKDIR /workspace
