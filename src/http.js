import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

export function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

export async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request exceeds the 8 MB local limit");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function staticFile(response, pathname, publicDir, headers = {}) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(publicDir, relative));
  if (!file.startsWith(publicDir)) return json(response, 403, { error: "Forbidden" });
  try { if (!(await stat(file)).isFile()) return json(response, 404, { error: "Not found" }); }
  catch { return json(response, 404, { error: "Not found" }); }
  response.writeHead(200, {
    "content-type": contentTypes[extname(file)] || "application/octet-stream",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    "x-content-type-options": "nosniff",
    ...headers
  });
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}

export function authorizeApi(request, response, url, apiToken) {
  if (!apiToken || !url.pathname.startsWith("/api/")) return true;
  const header = request.headers.authorization || request.headers["x-agent-plan-token"] || "";
  const presented = String(header).startsWith("Bearer ") ? String(header).slice(7) : String(header);
  if (presented && presented === String(apiToken)) return true;
  json(response, 401, { error: "Unauthorized" });
  return false;
}

export function createHandleRequest({ publicDir, requestContext, apiToken, host, port, api }) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    try {
      const context = await requestContext?.(request, url) || {};
      if (url.pathname.startsWith("/api/") && !authorizeApi(request, response, url, apiToken)) return;
      if (url.pathname.startsWith("/api/")) await api(request, response, url);
      else await staticFile(response, context.pathname || url.pathname, context.publicDir || publicDir, context.headers);
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error.message });
      else response.end();
    }
  };
}
