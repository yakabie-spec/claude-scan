// 書類スキャン Service Worker
const VERSION = "v2.2.1";
const SHELL_CACHE = "shell-" + VERSION;
const CDN_CACHE = "cdn-v1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "doc_rules.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/jscanify.js",
  "vendor/jspdf.umd.min.js",
  "vendor/opencv.js",
  "vendor/ort/ort.wasm.min.js",
  "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/ort/ort-wasm-simd-threaded.mjs",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // API 呼び出しはキャッシュしない
  if (url.hostname.includes("dropboxapi.com") || url.hostname.includes("dropbox.com") ||
      url.hostname.includes("anthropic.com")) return;

  // 同一オリジン: ネットワーク優先（更新を素早く反映）、失敗時キャッシュ
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }

  // CDN (opencv / jscanify / jspdf): キャッシュ優先（2回目以降の起動を高速化）
  if (["docs.opencv.org", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"].includes(url.hostname)) {
    e.respondWith(
      caches.match(e.request).then((hit) =>
        hit || fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CDN_CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
      )
    );
  }
});
