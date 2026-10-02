"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const stem = `impact0815-node-red-contrib-shelly-admin-${pkg.version}`;
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
for (const name of fs.readdirSync(dist)) fs.rmSync(path.join(dist, name), { recursive: true, force: true });

execFileSync("npm", ["pack", "--pack-destination", dist], { cwd: root, stdio: "inherit" });
const tarball = path.join(dist, `${stem}.tgz`);
if (!fs.existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-admin-release-"));
try {
  const projectStage = path.join(temp, "project", "node-red-contrib-shelly-admin");
  copyProject(root, projectStage, false);
  const projectZip = path.join(dist, `${stem}.zip`);
  zipDirectory(path.dirname(projectStage), "node-red-contrib-shelly-admin", projectZip);

  const releaseStage = path.join(temp, "release", "node-red-contrib-shelly-admin");
  copyProject(root, releaseStage, false);
  fs.mkdirSync(path.join(releaseStage, "dist"), { recursive: true });
  fs.copyFileSync(tarball, path.join(releaseStage, "dist", path.basename(tarball)));
  const releaseZip = path.join(dist, `${stem}-release.zip`);
  zipDirectory(path.dirname(releaseStage), "node-red-contrib-shelly-admin", releaseZip);

  const artifacts = [tarball, projectZip, releaseZip];
  const sums = artifacts.map((file) => `${sha256(file)}  ${path.basename(file)}`).join("\n") + "\n";
  fs.writeFileSync(path.join(dist, `SHA256SUMS-${pkg.version}.txt`), sums);
  fs.copyFileSync(path.join(root, `RELEASE-NOTES-${pkg.version}.md`), path.join(dist, `RELEASE-NOTES-${pkg.version}.md`));
  console.log(`Created ${artifacts.length + 2} release files in ${dist}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function copyProject(source, destination, includeDist) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter(item) {
      const relative = path.relative(source, item);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      if ([".git", "node_modules", "coverage"].includes(first)) return false;
      if (!includeDist && first === "dist") return false;
      return true;
    }
  });
}

function zipDirectory(cwd, directory, output) {
  execFileSync("zip", ["-q", "-r", output, directory], { cwd });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
