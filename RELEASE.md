# Release 0.3.0 operations

All commands assume the supplied project/release assets were downloaded locally. Review changes, back up the Node-RED user directory or Docker `/data` volume, and use an authorized test network plus a supervised pilot device.

## 1. Verify supplied assets

```bash
set -euo pipefail
ASSET_DIR="$HOME/Downloads/shelly-admin-0.3.0"
cd "$ASSET_DIR"
sha256sum -c SHA256SUMS-0.3.0.txt
unzip -t impact0815-node-red-contrib-shelly-admin-0.3.0.zip
unzip -t impact0815-node-red-contrib-shelly-admin-0.3.0-release.zip
tar -tzf impact0815-node-red-contrib-shelly-admin-0.3.0.tgz | head
```

PowerShell checksum verification:

```powershell
$ErrorActionPreference = 'Stop'
$AssetDir = "$HOME\Downloads\shelly-admin-0.3.0"
Set-Location $AssetDir
Get-Content .\SHA256SUMS-0.3.0.txt | ForEach-Object {
  $parts = $_ -split '\s+', 2
  $actual = (Get-FileHash -Algorithm SHA256 $parts[1]).Hash.ToLowerInvariant()
  if ($actual -ne $parts[0].ToLowerInvariant()) { throw "SHA256 mismatch: $($parts[1])" }
  "OK  $($parts[1])"
}
```

## 2. Test the project

```bash
set -euo pipefail
cd "$HOME/Downloads/shelly-admin-0.3.0/node-red-contrib-shelly-admin"
npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
git diff --check 2>/dev/null || true
```

## 3. Commit, tag and create the GitHub release

```bash
set -euo pipefail
REPO_DIR="$HOME/src/node-red-contrib-shelly-admin"
ASSET_DIR="$HOME/Downloads/shelly-admin-0.3.0"
PROJECT_DIR="$ASSET_DIR/node-red-contrib-shelly-admin"
cd "$REPO_DIR"
git switch main
git pull --ff-only origin main
rsync -a --delete --exclude='.git/' "$PROJECT_DIR/" "$REPO_DIR/"
npm ci && npm run check && npm run test:coverage
git diff --check
git add --all
git commit -m "Release 0.3.0"
git push origin main
git tag -s v0.3.0 -m "@impact0815/node-red-contrib-shelly-admin 0.3.0"
git push origin v0.3.0

gh release create v0.3.0 \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.3.0.tgz" \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.3.0.zip" \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.3.0-release.zip" \
  "$ASSET_DIR/SHA256SUMS-0.3.0.txt" \
  "$ASSET_DIR/RELEASE-NOTES-0.3.0.md" \
  --repo impact0815/node-red-contrib-shelly-admin \
  --title "v0.3.0" \
  --notes-file "$REPO_DIR/RELEASE-NOTES-0.3.0.md" \
  --verify-tag
```

If signed tags are unavailable, use `git tag -a v0.3.0 -m "@impact0815/node-red-contrib-shelly-admin 0.3.0"`.

## 4. Publish to npm

Publishing is intentionally separate and requires an authenticated account authorized for the scope:

```bash
set -euo pipefail
ASSET_DIR="$HOME/Downloads/shelly-admin-0.3.0"
npm whoami
npm view @impact0815/node-red-contrib-shelly-admin versions --json
npm publish "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.3.0.tgz" --access public --provenance
npm view @impact0815/node-red-contrib-shelly-admin@0.3.0 version dist.integrity
```

## 5. Install in Node-RED

Published package:

```bash
cd ~/.node-red
npm install --omit=dev --no-audit --no-fund @impact0815/node-red-contrib-shelly-admin@0.3.0
node -p "require('./node_modules/@impact0815/node-red-contrib-shelly-admin/package.json').version"
```

Supplied TGZ:

```bash
set -euo pipefail
cp -a "$HOME/.node-red" "$HOME/.node-red.backup-before-shelly-admin-0.3.0"
cd "$HOME/.node-red"
npm install --omit=dev --no-audit --no-fund "$HOME/Downloads/shelly-admin-0.3.0/impact0815-node-red-contrib-shelly-admin-0.3.0.tgz"
node -e "const p=require('./node_modules/@impact0815/node-red-contrib-shelly-admin/package.json'); if(p.version!=='0.3.0') process.exit(1); console.log(p.name,p.version)"
```

Restart Node-RED. Deploy the existing flow without recreating the config node. Verify persisted inventory/history, a read-only firmware check, `msg.action:"status"`, Start/Cancel buttons, a cancelled non-destructive run, the complete example dashboard, and the Monitor dialog tabs **Settings**, **Current Findings**, **History**, and **Device Details** (including loading, empty/error and populated states).

## 6. Disposable Docker smoke test

```bash
set -euo pipefail
ASSET="$HOME/Downloads/shelly-admin-0.3.0/impact0815-node-red-contrib-shelly-admin-0.3.0.tgz"
NAME=node-red-shelly-030
VOLUME=node-red-shelly-030-data
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true
docker volume create "$VOLUME"
docker run -d --name "$NAME" -p 1881:1880 -v "$VOLUME:/data" nodered/node-red:latest
docker cp "$ASSET" "$NAME:/data/shelly-admin-0.3.0.tgz"
docker exec "$NAME" sh -lc 'cd /data && npm install --omit=dev --no-audit --no-fund ./shelly-admin-0.3.0.tgz'
docker restart "$NAME"
sleep 15
docker exec "$NAME" node -e "const p=require('/data/node_modules/@impact0815/node-red-contrib-shelly-admin/package.json'); if(p.version!=='0.3.0') process.exit(1); console.log(p.name,p.version)"
docker inspect -f 'status={{.State.Status}} restarting={{.State.Restarting}} restarts={{.RestartCount}}' "$NAME"
docker logs --since 2m --tail 500 "$NAME" 2>&1 | tee /tmp/node-red-shelly-030.log
! grep -E 'Uncaught Exception|UnhandledPromiseRejection|SyntaxError|ERR_STATE_SCHEMA' /tmp/node-red-shelly-030.log
```

Open `http://localhost:1881`, import `examples/03-complete-operations-en.json` or `04-kompletter-betrieb-de.json`, restrict the target subnet, select a file Context store, deploy, run a read-only scan/check, and inspect the dashboard. Cleanup:

```bash
docker rm -f node-red-shelly-030
docker volume rm node-red-shelly-030-data
```

## 7. Upgrade an existing 0.2.0 Docker installation

```bash
set -euo pipefail
CONTAINER=node-red
ASSET_DIR="$HOME/Downloads/shelly-admin-0.3.0"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
BACKUP_FILE="node-red-data-before-shelly-admin-0.3.0-$(date +%Y%m%d-%H%M%S).tgz"
docker exec "$CONTAINER" node -e "const p=require('/data/node_modules/@impact0815/node-red-contrib-shelly-admin/package.json'); if(p.version!=='0.2.0') throw new Error('Expected 0.2.0, found '+p.version)"
docker stop "$CONTAINER"
docker run --rm --volumes-from "$CONTAINER" -v "$PWD:/backup" -e BACKUP_FILE="$BACKUP_FILE" --entrypoint sh "$IMAGE" -lc 'umask 077; tar -czf "/backup/$BACKUP_FILE" -C /data .'
docker run --rm --volumes-from "$CONTAINER" -v "$ASSET_DIR:/release:ro" --entrypoint sh "$IMAGE" -lc 'set -eu; cd /data; npm install --omit=dev --no-audit --no-fund /release/impact0815-node-red-contrib-shelly-admin-0.3.0.tgz'
docker start "$CONTAINER"
```

Keep the backup until inventory, history, Context-store selection, all three node types, read-only firmware checks, lifecycle output, editor controls and cancellation have been verified. Roll back by stopping the container and restoring `/data` from the backup archive.
