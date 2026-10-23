import { spawnSync } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
if (dirname(output) !== root || basename(output) !== "dist") throw new Error("Invalid package output");
try {
  const entry = await lstat(output);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Refuse linked package output");
  await rm(output, { recursive: true });
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
}
const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
