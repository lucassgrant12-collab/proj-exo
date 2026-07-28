// Minimal, dependency-free static file server for the web/ prototype.
// Deliberately not using a package like `serve` — this way Railway just
// needs Node itself, the same reliable builder path already proven to work
// for backend/, nothing extra to install.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not a raw string built from import.meta.url — a plain
// `new URL(".", import.meta.url).pathname` leaves a leading slash in front
// of the drive letter on Windows ("/C:/Users/...") which breaks when used
// directly as a filesystem path. Same class of bug as the server.ts
// startup-guard fix earlier in this project; fileURLToPath is the correct,
// cross-platform way to do this conversion.
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (pathname === "/") pathname = "/index.html";

    // Strip any ".." segments before joining, so a request can't escape ROOT.
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(ROOT, safePath);

    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Atlas web listening on port ${PORT}`);
});
