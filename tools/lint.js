"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceRoots = ["lib", "nodes", "test", "tools"];
const files = sourceRoots.flatMap((directory) => walk(path.join(root, directory)));
const errors = [];

for (const file of files) {
  const relative = path.relative(root, file);
  const content = fs.readFileSync(file, "utf8");
  if (/\r/.test(content)) errors.push(`${relative}: CRLF line ending`);
  content.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${relative}:${index + 1}: trailing whitespace`);
    if (/\t/.test(line) && file.endsWith(".js")) errors.push(`${relative}:${index + 1}: tab indentation`);
  });
  if (file.endsWith(".js")) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) errors.push(`${relative}: ${result.stderr.trim()}`);
  }
  if (file.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (error) {
      errors.push(`${relative}: invalid JSON: ${error.message}`);
    }
  }
}

for (const example of walk(path.join(root, "examples")).filter((file) => file.endsWith(".json"))) {
  try {
    JSON.parse(fs.readFileSync(example, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(root, example)}: invalid JSON: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Lint passed: ${files.length} source files and JSON examples validated.`);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
