export function prefixCompactImageUrl(value, basePath = "") {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const url = value.trim();
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return url;
  if (url.startsWith("/")) {
    if (!basePath || url === basePath || url.startsWith(`${basePath}/`)) return url;
    return `${basePath}${url}`;
  }
  if (!basePath) return url;
  const match = url.match(/^([^?#]*)([?#].*)?$/);
  const stack = basePath.split("/").filter(Boolean);
  const baseDepth = stack.length;
  for (const segment of match[1].split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > baseDepth) stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return `/${stack.join("/")}${match[2] ?? ""}`;
}

export function compactImageSource(part, basePath = "") {
  if (!part || typeof part !== "object") return undefined;
  const mime = typeof part.mime === "string" ? part.mime : typeof part.mimeType === "string" ? part.mimeType : "";
  let value = typeof part.url === "string" ? part.url : undefined;
  if (!value && typeof part.data === "string" && part.data && mime) value = `data:${mime};base64,${part.data}`;
  if (!value) return undefined;
  if (/^data:/i.test(value) && !/^data:image\/[\w.+-]+(?:;[^,]*)?,/i.test(value)) return undefined;
  if (part.type !== "image" && !mime.startsWith("image/") && !/^data:image\//i.test(value)) return undefined;
  return prefixCompactImageUrl(value, basePath);
}

export function isImageMarkdown(text) {
  return typeof text === "string" && /!\[[^\]]*\]\(\s*<?[^)\s]+/i.test(text);
}

export function prefixMarkdownImageUrls(text, basePath = "") {
  if (typeof text !== "string" || !basePath) return text;
  return text.replace(/(!\[[^\]]*\]\(\s*<?)([^\s)>]+)(>?)/g, (whole, before, url, close) => {
    const prefixed = prefixCompactImageUrl(url, basePath);
    return `${before}${prefixed ?? url}${close}`;
  });
}

export function toolOutputImageParts(output) {
  const found = [];
  const visited = new Set();
  const visit = (value, depth) => {
    if (depth > 6 || found.length >= 24 || !value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if ((value.type === "image" || value.type === "file") && (
      value.type === "image" ||
      String(value.mime ?? value.mimeType ?? "").startsWith("image/") ||
      typeof value.url === "string" ||
      typeof value.data === "string"
    )) {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const key of ["content", "images", "parts", "output"]) {
      if (key in value) visit(value[key], depth + 1);
    }
  };
  visit(output, 0);
  return found;
}
