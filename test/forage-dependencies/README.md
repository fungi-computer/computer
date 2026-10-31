# Offline Forage build inputs

This is a dependency layer for the real Forage package build. The generated
standalone pnpm lock pins its dependency closure; it does not replace the root
workspace lock. `source-manifest.json` identifies the 13 unchanged tracked
inputs at `25408429035cb19deaa87d1f736ddc6374484770`. No package source,
node_modules or completed dist is copied into the dependency image.

The base Computer image comes from `2ff54dd` and provides Node 24.20.0 and pnpm
11.24.0. Build it with the ordinary Computer Dockerfile before building this
layer. `COMPUTER_IMAGE` can name the resulting qualified image when its local
tag differs.

## Reproduce

From the repository root, materialize the manifest's exact Git inputs in a fresh
ignored directory. This copies tracked source only, not the current working
tree's generated outputs:

```sh
python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
manifest = json.loads(Path('packages/computer/test/forage-dependencies/source-manifest.json').read_text())
destination = Path('.botanical/forage-offline-reproduction')
destination.mkdir(parents=True, exist_ok=False)
for row in manifest['files']:
    content = subprocess.check_output(['git', 'show', manifest['revision'] + ':' + row['path']])
    assert hashlib.sha256(content).hexdigest() == row['sha256']
    path = destination / row['path']
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
PY
```

Use the repository's bounded proof runner and the shared execution window for
Docker commands. Build the dependency layer using pnpm's ordinary frozen
install. The image retains both its content-addressable store and registry
metadata cache, including the metadata needed by offline supply-chain checks:

```sh
docker build --tag botanical-forage-dependencies:2ff54dd \
  --file packages/computer/test/forage-dependencies.Dockerfile \
  --build-arg FORAGE_SOURCE_REVISION="$(git rev-parse 25408429035cb19deaa87d1f736ddc6374484770)" \
  --build-arg FORAGE_SOURCE_MANIFEST_SHA256="$(sha256sum packages/computer/test/forage-dependencies/source-manifest.json | cut -d' ' -f1)" \
  --build-arg FORAGE_DEPENDENCY_RECIPE_SHA256="$(sha256sum packages/computer/test/forage-dependencies.Dockerfile | cut -d' ' -f1)" \
  --build-context forage=.botanical/forage-offline-reproduction/packages/forage \
  packages/computer/test/forage-dependencies
```

Run the actual package build with no network. Copy the image's store and cache
seeds into disposable writable space: pnpm writes its SQLite index even offline,
and Computer commands run unprivileged. The install copies packages into this
run's own node_modules. Lifecycle scripts are disabled for the dependency
install; the explicit Forage build and smoke scripts run. Supply-chain policy
checks remain enabled.

```sh
docker run --rm --network none --entrypoint sh \
  --mount type=bind,src="$PWD/.botanical/forage-offline-reproduction",dst=/workspace \
  --workdir /workspace botanical-forage-dependencies:2ff54dd -eu -c '
    test ! -e packages/forage/dist
    cp /opt/forage-dependencies/pnpm-lock.yaml packages/forage/pnpm-lock.yaml
    install_root=$(mktemp -d)
    trap '\''rm -rf "$install_root"'\'' EXIT
    cp -R /opt/pnpm-store "$install_root/store"
    cp -R /opt/pnpm-cache "$install_root/cache"
    pnpm --dir packages/forage install --ignore-workspace --offline \
      --frozen-lockfile --ignore-scripts --store-dir "$install_root/store" \
      --cache-dir "$install_root/cache" \
      --package-import-method=copy
    pnpm --dir packages/forage run build
    pnpm --dir packages/forage run smoke
    find packages/forage/dist -type f -exec sha256sum {} +
  '
```

Compare emitted output hashes with the recovered files and recheck every source
hash. The local bind mount proves recoverable offline build outputs; it does not
prove hosted Mycelium transfer or Computer Workspace persistence. The hosted run
must use authorized file operations and recover from the same Home separately.

The Hub image helper verifies the source revision, manifest digest and
dependency recipe digest labels. A historical image ID or source-only match
cannot qualify an image built with an older offline dependency recipe.

## Lock provenance and accepted run

The lock was generated from the unchanged Forage package.json using pnpm 11.24.0
in the qualified Linux image:
`pnpm install --lockfile-only --ignore-workspace --ignore-scripts`. No lock
entries were hand-authored. Refresh only through this maintained command when
intentionally changing the pinned workload, then qualify offline again.

On September 9, `run-u4248` resolved 73 lock entries, `run-u4249` fetched the
Linux closure, and `run-u4256` installed 48 packages with zero downloads under
`--network none`. Build and smoke exited 0. All 13 source hashes remained equal;
18 emitted files (46,131 bytes) matched the hashes recovered in the isolated
lane. All scopes ended success/inactive/dead with empty control groups and the
named disposable containers were absent.

The resulting dependency image is
`sha256:8dddc8684720a958edd7708e1b4aab852944efcb368572dbce082f111cc7adf6`. Raw
command output and recovered output hashes are in the producing lane's ignored
`.botanical/hosted-forage/{dependency-resolution.log,dependency-image-build.log,offline-build.log,offline-build-result.json}`.
Earlier base-image results are summarized in `image-qualification.json` there;
their original raw stdout exists only in the native tool transcript, not a saved
log. No base-image probe was repeated to create this record.
