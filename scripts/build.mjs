// Production build: the site is plain ES modules with no compile step, so the export is a
// verbatim copy of src/ into dist/, followed by the same checks as `npm run check`.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkExport } from "./check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });

const problems = checkExport(root);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("dist/ written from src/ and checked.");
