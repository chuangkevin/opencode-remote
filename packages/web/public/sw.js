const CACHE_NAME = "opencode-remote-shell-v2";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];
const STATIC_DESTINATIONS = new Set(["style", "script", "image", "font"]);

function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

function isStaticRequest(request) {
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return false;
  }

  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    return false;
  }

  if (request.mode === "navigate") {
    return true;
  }

  if (request.destination && STATIC_DESTINATIONS.has(request.destination)) {
    return true;
  }

  return url.pathname.endsWith(".webmanifest");
}

async function cacheStaticResponse(request, response) {
  if (!response.ok || response.type !== "basic" || !isStaticRequest(request) || !isSameOrigin(request.url)) {
    return response;
  }

  const cacheControl = response.headers.get("cache-control") ?? "";
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) {
    return response;
  }

  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith("http")) {
    return;
  }

  if (!isSameOrigin(request.url)) {
    return;
  }

  if (request.url.includes("/api/") || request.url.includes("/health")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match("/");
        return cached || Response.error();
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      if (!isStaticRequest(request)) {
        return fetch(request);
      }

      return fetch(request).then((response) => cacheStaticResponse(request, response));
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      return clients.openWindow(targetUrl);
    }),
  );
});
