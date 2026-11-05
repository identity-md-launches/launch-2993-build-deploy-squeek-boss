// Static export checks: dist/ matches src/ byte for byte, every local URL in index.html is
// relative and exists, and the share metadata is present.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** @param {string} root @returns {string[]} problems */
export function checkExport(root) {
  const problems = [];
  const src = join(root, "src");
  const dist = join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) return ["dist/index.html is missing"];

  const srcFiles = walk(src).map((p) => relative(src, p)).sort();
  const distFiles = walk(dist).map((p) => relative(dist, p)).sort();
  if (srcFiles.join() !== distFiles.join()) problems.push(`dist/ file list differs from src/: ${distFiles.join(", ")}`);
  for (const f of srcFiles) {
    const d = join(dist, f);
    if (existsSync(d) && !readFileSync(join(src, f)).equals(readFileSync(d))) problems.push(`dist/${f} differs from src/${f}`);
  }

  const html = readFileSync(join(dist, "index.html"), "utf8");
  for (const m of html.matchAll(/\b(?:src|href|content)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:|#)/.test(url) || !/^\.?\.?\//.test(url)) continue;
    if (url.startsWith("/")) problems.push(`absolute local URL in index.html: ${url}`);
    const path = url.split(/[?#]/)[0];
    if (path !== "./" && !existsSync(join(dist, path))) problems.push(`missing file for ${url}`);
  }
  for (const m of readFileSync(join(dist, "assets", "app.js"), "utf8").matchAll(/from "(\.[^"]+)"/g)) {
    if (!existsSync(join(dist, "assets", m[1]))) problems.push(`missing module ${m[1]}`);
  }
  const need = [
    [/<title>[^<]{3,}<\/title>/, "title"],
    [/rel="icon"/, "favicon"],
    [/name="description"/, "description"],
    [/property="og:title"/, "og:title"],
    [/property="og:image"/, "og:image"],
  ];
  for (const [re, name] of need) if (!re.test(html)) problems.push(`index.html lacks ${name}`);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkExport(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("Export check passed.");
}
