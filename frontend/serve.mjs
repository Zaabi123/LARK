// Local preview of dist/ at http://localhost:5310 (npm run dev).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("./dist/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\/]+/, "") || "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-cache" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(5310, "127.0.0.1", () => console.log("Dashboard: http://localhost:5310"));
