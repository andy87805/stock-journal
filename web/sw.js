// 快取名稱改動會觸發重新安裝並清掉舊快取。改了 app 殼層的快取策略時記得換版號。
const CACHE = "stock-journal-v7";

// 每次部署都會變的檔案：一律先走網路，離線才回退快取。
// 之前這些是 cache-first，導致改版後使用者永遠看到舊版（sw.js 沒變就不會重新安裝，
// 舊 app.js 就一直從快取吐出來），資料看起來像沒同步到。
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
];

// 不會變的資源，走 cache-first 省流量
const STATIC_ASSETS = ["./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...APP_SHELL, ...STATIC_ASSETS]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Firestore/Auth 自己管離線與快取，不要插手
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com")) return;

  // 跨網域資源（Firebase SDK）走 cache-first，版本固定在網址裡不會過期
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  const isStatic = url.pathname.includes("/icons/");
  if (isStatic) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
  );
});
