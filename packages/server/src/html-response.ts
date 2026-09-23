import { gzipSync } from "node:zlib";
import type http from "node:http";

function acceptEncodingHeader(req: Pick<http.IncomingMessage, "headers"> | undefined): string {
  const value = req?.headers?.["accept-encoding"];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export function clientAcceptsGzip(req: Pick<http.IncomingMessage, "headers"> | undefined): boolean {
  return acceptEncodingHeader(req).toLowerCase().includes("gzip");
}

export function encodeHtmlBody(
  req: Pick<http.IncomingMessage, "headers" | "method"> | undefined,
  html: string | Buffer,
): { body: Buffer; contentEncoding?: "gzip" } {
  const buf = Buffer.isBuffer(html) ? html : Buffer.from(html, "utf8");
  if (req && clientAcceptsGzip(req)) {
    return { body: gzipSync(buf), contentEncoding: "gzip" };
  }
  return { body: buf };
}

export function sendHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  html: string | Buffer,
  extraHeaders: http.OutgoingHttpHeaders,
): void {
  const { body, contentEncoding } = encodeHtmlBody(req, html);
  const headers: http.OutgoingHttpHeaders = {
    ...extraHeaders,
    Vary: "Accept-Encoding",
    "Content-Length": String(body.byteLength),
  };
  if (contentEncoding) headers["Content-Encoding"] = contentEncoding;
  res.writeHead(200, headers);
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}
