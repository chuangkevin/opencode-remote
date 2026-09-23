export type ProxyEncoding = "br" | "gzip";

function headerText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export function parseProxyAcceptEncoding(header: string | string[] | undefined): { br: boolean; gzip: boolean } {
  const text = headerText(header).toLowerCase();
  return { br: text.includes("br"), gzip: text.includes("gzip") };
}

export function isCompressibleUpstreamContentType(contentType: string | string[] | undefined): boolean {
  const text = headerText(contentType);
  if (text === "") return false;
  if (/text\/event-stream/i.test(text)) return false;
  return /(javascript|ecmascript|css|json|svg|html|text|xml)/i.test(text);
}

export function shouldCompressUpstream(options: {
  method?: string;
  statusCode?: number;
  upstreamPath: string;
  upstreamContentEncoding?: string | string[];
  upstreamContentType?: string | string[];
  clientAcceptEncoding?: string | string[];
}): ProxyEncoding | undefined {
  if ((options.method ?? "GET").toUpperCase() === "HEAD") return undefined;
  if ((options.statusCode ?? 200) !== 200) return undefined;
  if (!options.upstreamPath.startsWith("/assets/") && !options.upstreamPath.startsWith("/_assets/")) return undefined;
  if (headerText(options.upstreamContentEncoding) !== "") return undefined;
  if (!isCompressibleUpstreamContentType(options.upstreamContentType)) return undefined;
  const accepted = parseProxyAcceptEncoding(options.clientAcceptEncoding);
  if (accepted.br) return "br";
  if (accepted.gzip) return "gzip";
  return undefined;
}
