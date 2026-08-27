// Serves dist/ over plain HTTP with permissive CORS, so a contributor can
// `pnpm build` then add http://localhost:8787 as a repo in the app and
// iterate against a live catalogue without publishing anything. This is
// the loop the README documents, so it has to actually work end to end:
// real static file serving (correct Content-Type per extension, safe
// against path traversal), not a stub.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// See build.ts for why this is not `fileURLToPath(new URL("..", import.meta.url))`.
const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DIST_DIR = join(REPO_ROOT, "dist");
const PORT = 8787;

const MIME_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolves a request path to a file under DIST_DIR, refusing anything
 *  that would escape it (e.g. "/../../etc/passwd"). Returns null when the
 *  resolved path is outside DIST_DIR. */
function resolveWithinDist(requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const resolved = join(DIST_DIR, decoded);
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + sep)) {
    return null;
  }
  return resolved;
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const requestPath = new URL(req.url ?? "/", `http://localhost:${PORT}`).pathname;
  const filePath = resolveWithinDist(requestPath);
  if (filePath === null) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  void (async () => {
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": body.byteLength,
        "Cache-Control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  })();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — is another dev-repo already running?`);
  } else {
    console.error(err.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, () => {
  if (!existsSync(DIST_DIR)) {
    console.log("dist/ does not exist yet — run `pnpm build` first, or requests will 404.");
  }
  console.log(`Serving dist/ at http://localhost:${PORT}`);
  console.log(`Add http://localhost:${PORT} as a repo in the app to iterate locally.`);
});
