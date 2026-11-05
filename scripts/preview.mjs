// Minimal static preview of dist/ under a subpath, so broken relative URLs show up.
// Usage: npm run preview, then open http://localhost:4173/preview/
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT) || 4173;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (!url.pathname.startsWith("/preview/")) {
    res.writeHead(302, { Location: "/preview/" });
    return res.end();
  }
  let path = normalize(decodeURIComponent(url.pathname.slice("/preview/".length))).replace(/^(\.\.[/\\])+/, "");
  if (!path || path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(dist, path));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, () => console.log(`Preview: http://localhost:${port}/preview/`));
