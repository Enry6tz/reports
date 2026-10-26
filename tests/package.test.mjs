import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("package metadata uses the approved public identity without dependency changes", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(manifest.name, "@e6tz/reports");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.license, "MIT");
  assert.equal(lock.packages[''].license, 'MIT');
  const license = await read('LICENSE');
  assert.match(license, /^MIT License\r?$/m);
  assert.match(license, /Copyright \(c\) 2026 Enry6tz/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.doesNotMatch(await read('README.md'), /UNLICENSED/);
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.equal(manifest.scripts["test:package"], "node scripts/test-package.mjs");
});

test("product branding is removed while the neutral form hook remains", async () => {
  const oldBrand = new RegExp("a" + "side", "i");
  for (const path of ["package.json", "package-lock.json", "README.md", "src/http.ts", "src/react.tsx"]) {
    assert.doesNotMatch(await read(path), oldBrand, path);
  }
  assert.match(await read("src/react.tsx"), /data-reports="form"/);
});

test("CI checks supported Node releases with read-only permissions and no publishing", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  for (const expected of ["push:", "pull_request:", "contents: read", "node: [22, 24]", "npm ci --ignore-scripts --no-audit --no-fund", "npm run typecheck", "npm test", "npm run test:package"]) {
    assert.ok(workflow.includes(expected), expected);
  }
  assert.doesNotMatch(workflow, /secrets\.|npm publish|write-all|contents: write/);
});
