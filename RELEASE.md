# Release 0.2.0 operations

All commands assume that the supplied project directory and release assets have been downloaded locally. Review `git diff`, use a supervised pilot deployment, and keep a backup of the Node-RED user directory or Docker `/data` volume.

## 1. Verify release assets

### Linux/macOS

```bash
set -euo pipefail
ASSET_DIR="$HOME/Downloads/shelly-admin-0.2.0"
cd "$ASSET_DIR"
sha256sum -c SHA256SUMS-0.2.0.txt
```

### PowerShell 7+

```powershell
$ErrorActionPreference = 'Stop'
$AssetDir = "$HOME\Downloads\shelly-admin-0.2.0"
Set-Location $AssetDir
Get-Content .\SHA256SUMS-0.2.0.txt | ForEach-Object {
    $parts = $_ -split '\s+', 2
    $actual = (Get-FileHash -Algorithm SHA256 $parts[1]).Hash.ToLowerInvariant()
    if ($actual -ne $parts[0].ToLowerInvariant()) { throw "SHA256 mismatch: $($parts[1])" }
    "OK  $($parts[1])"
}
```

## 2. Copy into the Git checkout, test, commit, push and tag

### Bash / Git / GitHub CLI

```bash
set -euo pipefail
REPO_DIR="$HOME/src/node-red-contrib-shelly-admin"
ASSET_DIR="$HOME/Downloads/shelly-admin-0.2.0"
PROJECT_DIR="$ASSET_DIR/node-red-contrib-shelly-admin"

cd "$REPO_DIR"
git switch main
git pull --ff-only origin main
rsync -a --delete --exclude='.git/' "$PROJECT_DIR/" "$REPO_DIR/"

npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
git diff --check
git status --short
git diff --stat

git add --all
git commit -m "Release 0.2.0"
git push origin main
git tag -s v0.2.0 -m "@impact0815/node-red-contrib-shelly-admin 0.2.0"
git push origin v0.2.0

gh release create v0.2.0 \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz" \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.2.0.zip" \
  "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.2.0-release.zip" \
  "$ASSET_DIR/SHA256SUMS-0.2.0.txt" \
  "$ASSET_DIR/RELEASE-NOTES-0.2.0.md" \
  --repo impact0815/node-red-contrib-shelly-admin \
  --title "v0.2.0" \
  --notes-file "$REPO_DIR/RELEASE-NOTES-0.2.0.md" \
  --verify-tag
```

If signed tags are not configured, use this annotated-tag command instead of `git tag -s`:

```bash
git tag -a v0.2.0 -m "@impact0815/node-red-contrib-shelly-admin 0.2.0"
```

### PowerShell 7+ / Git / GitHub CLI

```powershell
$ErrorActionPreference = 'Stop'
$RepoDir = "$HOME\src\node-red-contrib-shelly-admin"
$AssetDir = "$HOME\Downloads\shelly-admin-0.2.0"
$ProjectDir = Join-Path $AssetDir 'node-red-contrib-shelly-admin'

Set-Location $RepoDir
git switch main
git pull --ff-only origin main
Get-ChildItem -Force $RepoDir | Where-Object Name -ne '.git' | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $ProjectDir '*') -Destination $RepoDir -Recurse -Force
Get-ChildItem -Force $ProjectDir | Where-Object Name -like '.*' | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $RepoDir -Recurse -Force
}

npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
git diff --check
git status --short
git diff --stat

git add --all
git commit -m 'Release 0.2.0'
git push origin main
git tag -s v0.2.0 -m '@impact0815/node-red-contrib-shelly-admin 0.2.0'
git push origin v0.2.0

gh release create v0.2.0 `
  (Join-Path $AssetDir 'impact0815-node-red-contrib-shelly-admin-0.2.0.tgz') `
  (Join-Path $AssetDir 'impact0815-node-red-contrib-shelly-admin-0.2.0.zip') `
  (Join-Path $AssetDir 'impact0815-node-red-contrib-shelly-admin-0.2.0-release.zip') `
  (Join-Path $AssetDir 'SHA256SUMS-0.2.0.txt') `
  (Join-Path $AssetDir 'RELEASE-NOTES-0.2.0.md') `
  --repo impact0815/node-red-contrib-shelly-admin `
  --title 'v0.2.0' `
  --notes-file (Join-Path $RepoDir 'RELEASE-NOTES-0.2.0.md') `
  --verify-tag
```

PowerShell fallback for an annotated, unsigned tag:

```powershell
git tag -a v0.2.0 -m '@impact0815/node-red-contrib-shelly-admin 0.2.0'
```

## 3. Publish to npm

Authenticate first (`npm login`) and verify the account/scope. Publishing is intentionally a separate explicit action:

```bash
set -euo pipefail
ASSET_DIR="$HOME/Downloads/shelly-admin-0.2.0"
npm whoami
npm view @impact0815/node-red-contrib-shelly-admin versions --json
npm publish "$ASSET_DIR/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz" --access public --provenance
npm view @impact0815/node-red-contrib-shelly-admin@0.2.0 version dist.integrity
```

PowerShell:

```powershell
$ErrorActionPreference = 'Stop'
$AssetDir = "$HOME\Downloads\shelly-admin-0.2.0"
npm whoami
npm view '@impact0815/node-red-contrib-shelly-admin' versions --json
npm publish (Join-Path $AssetDir 'impact0815-node-red-contrib-shelly-admin-0.2.0.tgz') --access public --provenance
npm view '@impact0815/node-red-contrib-shelly-admin@0.2.0' version dist.integrity
```

## 4. Link a checkout into Node-RED for development

### Bash

```bash
set -euo pipefail
REPO_DIR="$HOME/src/node-red-contrib-shelly-admin"
NODE_RED_DIR="$HOME/.node-red"
cd "$REPO_DIR"
npm ci
npm test
npm link
cd "$NODE_RED_DIR"
npm link @impact0815/node-red-contrib-shelly-admin
node-red-stop || true
node-red-start
```

Remove the link and return to the published package:

```bash
cd "$HOME/.node-red"
npm unlink @impact0815/node-red-contrib-shelly-admin
npm install @impact0815/node-red-contrib-shelly-admin@0.2.0
```

### PowerShell

```powershell
$ErrorActionPreference = 'Stop'
$RepoDir = "$HOME\src\node-red-contrib-shelly-admin"
$NodeRedDir = "$HOME\.node-red"
Set-Location $RepoDir
npm ci
npm test
npm link
Set-Location $NodeRedDir
npm link '@impact0815/node-red-contrib-shelly-admin'
# Restart the Node-RED service/process used on this host.
```

## 5. Install the tarball in a local Node-RED user directory

```bash
set -euo pipefail
cp -a "$HOME/.node-red" "$HOME/.node-red.backup-before-shelly-admin-0.2.0"
cd "$HOME/.node-red"
npm install --omit=dev --no-audit --no-fund "$HOME/Downloads/shelly-admin-0.2.0/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz"
node -p "require('./node_modules/@impact0815/node-red-contrib-shelly-admin/package.json').version"
```

The version command must print `0.2.0`. Restart Node-RED, deploy the existing flow without recreating its config node, and verify the state-schema migration warning/status, inventory count, monitoring, and a read-only firmware check.

## 6. Docker smoke test in a disposable Node-RED container

```bash
set -euo pipefail
ASSET="$HOME/Downloads/shelly-admin-0.2.0/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz"
docker rm -f node-red-shelly-020 >/dev/null 2>&1 || true
docker volume rm node-red-shelly-020-data >/dev/null 2>&1 || true
docker volume create node-red-shelly-020-data
docker run -d --name node-red-shelly-020 -p 1881:1880 -v node-red-shelly-020-data:/data nodered/node-red:latest
docker cp "$ASSET" node-red-shelly-020:/data/shelly-admin-0.2.0.tgz
docker exec node-red-shelly-020 sh -lc 'cd /data && npm install --omit=dev --no-audit --no-fund ./shelly-admin-0.2.0.tgz'
docker restart node-red-shelly-020
sleep 15
docker exec node-red-shelly-020 node -p "require('/data/node_modules/@impact0815/node-red-contrib-shelly-admin/package.json').version"
docker inspect -f 'status={{.State.Status}} restarting={{.State.Restarting}} restarts={{.RestartCount}}' node-red-shelly-020
docker logs --since 2m --tail 500 node-red-shelly-020 2>&1 | tee /tmp/node-red-shelly-020.log
! grep -E 'Uncaught Exception|UnhandledPromiseRejection|SyntaxError|ERR_STATE_SCHEMA' /tmp/node-red-shelly-020.log
```

Open `http://localhost:1881`, import `examples/01-discovery-monitor.json`, select a file Context store, restrict targets to an authorized test network, and deploy.

Cleanup:

```bash
docker rm -f node-red-shelly-020
docker volume rm node-red-shelly-020-data
```

## 7. Upgrade an existing Node-RED Docker container from 0.1.4.1

```bash
set -euo pipefail
CONTAINER=node-red
ASSET_DIR="$HOME/Downloads/shelly-admin-0.2.0"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")"
BACKUP_DIR="$PWD"
BACKUP_FILE="node-red-data-before-shelly-admin-0.2.0-$(date +%Y%m%d-%H%M%S).tgz"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

docker exec "$CONTAINER" node -e "const p=require('/data/node_modules/@impact0815/node-red-contrib-shelly-admin/package.json'); if(p.version!=='0.1.4.1') throw new Error('Expected 0.1.4.1, found '+p.version); console.log(p.name,p.version)"
docker stop "$CONTAINER"
docker run --rm --volumes-from "$CONTAINER" -v "$BACKUP_DIR:/backup" -e BACKUP_FILE="$BACKUP_FILE" --entrypoint sh "$IMAGE" -lc 'umask 077; tar -czf "/backup/$BACKUP_FILE" -C /data .'
docker run --rm --volumes-from "$CONTAINER" -v "$ASSET_DIR:/release:ro" --entrypoint sh "$IMAGE" -lc 'set -eu; cd /data; npm install --omit=dev --no-audit --no-fund /release/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz; node -e "const p=require(\"/data/node_modules/@impact0815/node-red-contrib-shelly-admin/package.json\"); if(p.version!==\"0.2.0\") process.exit(1); console.log(p.name,p.version)"'
docker start "$CONTAINER"
sleep 15
docker inspect -f 'status={{.State.Status}} restarting={{.State.Restarting}} restarts={{.RestartCount}}' "$CONTAINER"
docker logs --since "$STARTED_AT" --tail 500 "$CONTAINER" 2>&1 | tee /tmp/node-red-shelly-020-upgrade.log
! grep -E 'Uncaught Exception|UnhandledPromiseRejection|SyntaxError' /tmp/node-red-shelly-020-upgrade.log
```

Keep the backup until the existing inventory, selected Context store, schema-2 migration, monitor lifecycle and a supervised read-only firmware check have been verified.
