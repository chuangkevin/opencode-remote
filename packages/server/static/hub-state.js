const HUB_HOSTS = Object.freeze(["mac", "l390", "home"]);

export function parseHubHost(search, storedHost = "mac") {
  const params = new URLSearchParams(search);
  const urlHost = params.get("host");
  if (HUB_HOSTS.includes(urlHost)) return urlHost;
  return HUB_HOSTS.includes(storedHost) ? storedHost : "mac";
}

export function hubHostUrl(host) {
  return `/?host=${HUB_HOSTS.includes(host) ? host : "mac"}`;
}

export function rewriteHubSessionHref(href, basePath) {
  let url;
  try {
    url = new URL(href, "https://opencode.sisihome.org");
  } catch {
    return undefined;
  }
  const path = url.pathname.replace(/^\/(?:sara|l390|home)(?=\/)/, "");
  if (!/^https?:$/.test(url.protocol) || !/^\/(?:c\/session\/[^/]+\/?|server\/[^/]+\/session\/[^/]+(?:\/.*)?)$/.test(path)) return undefined;
  const prefix = ["/sara", "/l390", "/home"].includes(basePath) ? basePath : "";
  const nativeMatch = path.match(/^\/server\/[^/]+\/session\/([^/]+)(\/.*)?$/);
  if (nativeMatch && prefix) {
    const origin = prefix === "/sara"
      ? "https://opencode-sara.sisihome.org"
      : prefix === "/l390"
        ? "https://opencode-l390.sisihome.org"
        : "https://opencode-home.sisihome.org";
    const key = btoa(origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${origin}/server/${key}/session/${nativeMatch[1]}${nativeMatch[2] ?? ""}${url.search}${url.hash}`;
  }
  return `${prefix}${path}${url.search}${url.hash}`;
}
