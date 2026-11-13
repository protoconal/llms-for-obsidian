const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const workflow = fs.readFileSync(path.join(__dirname, "../.github/workflows/bundle.yml"), "utf8");
const script = workflow.match(/      - run: \|\n((?: {10}.+\n)+)        env:/)[1]
  .split("\n").map(line => line.slice(10)).join("\n");

function runRelease(existing, fail = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
  try {
    fs.mkdirSync(path.join(dir, "release"));
    fs.writeFileSync(path.join(dir, "release", "bundle.zip"), "");
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[3] === "view" && process.env.EXISTING === "false") process.exit(1);
if (process.argv[3] === process.env.FAIL) process.exit(1);
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: path.join(dir, "calls"),
        EXISTING: String(existing), FAIL: fail, GITHUB_REF_NAME: "v1.0.0", GITHUB_REPOSITORY: "owner/repo" }
    });
    const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    return { status: result.status, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("release workflow creates missing releases and uploads assets", () => {
  const { status, calls } = runRelease(false);
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["release", "view", "v1.0.0", "--repo", "owner/repo"],
    ["release", "create", "v1.0.0", "--repo", "owner/repo", "--generate-notes"],
    ["release", "upload", "v1.0.0", "release/bundle.zip", "--repo", "owner/repo", "--clobber"]
  ]);
});

test("release workflow replaces assets without recreating an existing release", () => {
  const { status, calls } = runRelease(true);
  assert.equal(status, 0);
  assert.deepEqual(calls.map(call => call[1]), ["view", "upload"]);
  assert.ok(calls[1].includes("--clobber"));
});

test("release workflow propagates create and upload failures", () => {
  const create = runRelease(false, "create");
  assert.notEqual(create.status, 0);
  assert.deepEqual(create.calls.map(call => call[1]), ["view", "create"]);
  const upload = runRelease(true, "upload");
  assert.notEqual(upload.status, 0);
  assert.deepEqual(upload.calls.map(call => call[1]), ["view", "upload"]);
});
