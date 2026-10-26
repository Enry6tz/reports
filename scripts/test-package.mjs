import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this script with npm run test:package");
const scratch = await mkdtemp(join(tmpdir(), "reports-package-"));
console.log(`Package verification scratch (retained): ${scratch}`);
const userConfig = join(scratch, "user.npmrc");
const globalConfig = join(scratch, "global.npmrc");
await writeFile(userConfig, "");
await writeFile(globalConfig, "");
const environment = { ...process.env, npm_config_cache: join(scratch, "cache"), npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_registry: "https://registry.npmjs.org" };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);
const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", scratch], root));
assert.equal(packed.length, 1);
assert.equal(packed[0].name, "@e6tz/reports");
const paths = packed[0].files.map(file => file.path);
for (const file of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/browser.js", "dist/browser.d.ts", "dist/react.js", "dist/react.d.ts"]) {
  assert.ok(paths.includes(file), `Missing package file: ${file}`);
}
assert.ok(paths.every(path => path === "package.json" || path === "README.md" || path === "LICENSE" || /^dist\/.+\.(?:js|d\.ts)$/.test(path)), `Unexpected package files: ${paths.join(", ")}`);
const tarball = join(scratch, packed[0].filename);
const compiler = require.resolve("typescript/bin/tsc");
const coreProbe = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createReportsClient, createHttpReportsTransport } from "@e6tz/reports";
import { collectReportContext, readReportImage } from "@e6tz/reports/browser";
import metadata from "@e6tz/reports/package.json" with { type: "json" };
assert.equal(metadata.name, "@e6tz/reports");
assert.equal(metadata.license, "MIT");
assert.equal(typeof readReportImage, "function");
assert.equal(collectReportContext({ pathname: "/settings?secret=1", now: () => 0 }).pathname, "/settings");
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve("react"), { code: "MODULE_NOT_FOUND" });
const id = "d5555555-5555-4555-8555-555555555555";
let calls = 0;
const client = createReportsClient({ createId: () => id, transport: createHttpReportsTransport({ endpoint: "/reports", fetch: async (url, init) => {
  calls++;
  assert.equal(url, "/reports");
  assert.equal(JSON.parse(init.body).submissionId, id);
  assert.equal(init.credentials, "omit");
  return Response.json({ data: { submissionId: id, reportId: "REP-1", documentId: 1, receivedAt: "2026-10-26T00:00:00.000Z", status: "accepted" } });
} }) });
client.prepare({ message: "Packed consumer report" });
assert.equal(calls, 0);
assert.equal((await client.send()).status, "accepted");
assert.equal((await client.send()).status, "accepted");
assert.equal(calls, 1);
client.dispose();
console.log("Core/browser consumer without React passed");
`;
const coreTypes = `
import { createReportsClient, createHttpReportsTransport, type ReportsClient } from "@e6tz/reports";
import { collectReportContext, readReportImage } from "@e6tz/reports/browser";
import metadata from "@e6tz/reports/package.json" with { type: "json" };
const client: ReportsClient = createReportsClient({ transport: createHttpReportsTransport({ endpoint: "/reports" }) });
client.prepare({ message: metadata.name, context: collectReportContext() });
void readReportImage(new Blob());
`;

async function consumer(name, packages = []) {
  const cwd = join(scratch, name);
  await mkdir(cwd);
  await writeFile(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module" }));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=optional", tarball, ...packages], cwd);
  await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: [], resolveJsonModule: true, jsx: "react-jsx" }, include: ["consumer.ts", "consumer.tsx"] }));
  return cwd;
}

const core = await consumer("core");
await writeFile(join(core, "consumer.mjs"), coreProbe);
await writeFile(join(core, "consumer.ts"), coreTypes);
run(process.execPath, [join(core, "consumer.mjs")], core);
run(process.execPath, [compiler, "-p", join(core, "tsconfig.json")], core);
console.log("Core/browser imports, delivery, and declarations passed");

for (const version of ["18.3.1", "19"]) {
  const major = version.split(".")[0];
  const cwd = await consumer(`react-${major}`, [`react@${version}`, `react-dom@${version}`, `@types/react@${major}`]);
  await writeFile(join(cwd, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createReportsClient } from "@e6tz/reports";
import { ReportForm, useReportsSnapshot } from "@e6tz/reports/react";
assert.equal(typeof useReportsSnapshot, "function");
const client = createReportsClient({ transport: async () => { throw new Error("Must not submit during rendering"); } });
const html = renderToStaticMarkup(createElement(ReportForm, { client }));
assert.match(html, /data-reports="form"/);
assert.match(html, /<textarea/);
client.dispose();
`);
  await writeFile(join(cwd, "consumer.tsx"), `${coreTypes}
import { ReportForm, useReportsSnapshot, type ReportFormProps } from "@e6tz/reports/react";
const props: ReportFormProps = { client };
const form = <ReportForm {...props} />;
const hook: typeof useReportsSnapshot = useReportsSnapshot;
void [form, hook];
`);
  run(process.execPath, [join(cwd, "consumer.mjs")], cwd);
  run(process.execPath, [compiler, "-p", join(cwd, "tsconfig.json")], cwd);
  const manifest = JSON.parse(await readFile(join(cwd, "node_modules/@e6tz/reports/package.json"), "utf8"));
  assert.equal(manifest.license, "MIT");
  assert.equal(await readFile(join(cwd, 'node_modules/@e6tz/reports/LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./browser", "./package.json", "./react"]);
  console.log(`React ${major} rendering, all exports, and declarations passed`);
}
