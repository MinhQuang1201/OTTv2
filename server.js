const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".ico": "image/x-icon"
};
const DENY = new Set([
  "server.js",
  "room.js",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".env",
  ".env.example",
  "partykit.json"
]);
const PRIVATE_DIRS = new Set(["partykit"]);

function publicPath(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent((urlPath || "/").split("?")[0]);
  } catch {
    return null;
  }
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const resolved = path.resolve(ROOT, rel);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) return null;
  const base = path.basename(resolved).toLowerCase();
  if (DENY.has(base)) return null;
  const firstSegment = rel.split(/[\\/]/)[0].toLowerCase();
  if (PRIVATE_DIRS.has(firstSegment)) return null;
  if (firstSegment === "node_modules" || firstSegment === "tests" || firstSegment.startsWith(".")) {
    return null;
  }
  return resolved;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end(err.code === "ENOENT" ? "Không tìm thấy" : "Lỗi máy chủ");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Chỉ nhận GET");
    return;
  }
  const filePath = publicPath(req.url);
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Không cho phép");
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Không tìm thấy");
      return;
    }
    sendFile(res, filePath);
  });
});

if (require.main === module) {
  server.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log("OTTv2 static files chạy tại http://localhost:" + (process.env.PORT || 3000));
  });
}

module.exports = { server, publicPath };
