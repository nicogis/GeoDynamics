import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const output = join(root, ".test-dist");
rmSync(output, { recursive: true, force: true });

const tsc = join(
  root,
  "node_modules",
  "typescript",
  "bin",
  "tsc"
);

const compile = spawnSync(
  process.execPath,
  [tsc, "-p", "tsconfig.tests.json"],
  { stdio: "inherit" }
);

if (compile.status !== 0) {
  process.exit(compile.status ?? 1);
}

const tests = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => join(root, "tests", name));

const run = spawnSync(
  process.execPath,
  ["--test", ...tests],
  { stdio: "inherit" }
);

process.exit(run.status ?? 1);
