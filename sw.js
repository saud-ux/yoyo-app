/* Service worker — offline app shell + cached fonts + range-aware audio */
const CACHE = "yoyo-ir1-v3";
const AUDIO = "./audio/yoyo.mp3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];
/* الصوت (≈٢٨ ميجا) لا يُحمَّل مع التثبيت — يُحمّله المستخدم بزر صريح. */

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* عنصر <audio> يطلب الملف على أجزاء بترويسة Range، فيرد الخادم بـ 206.
   الـ Cache API يرفض تخزين 206 (TypeError)، ويرفض مطابقتها أيضًا — لذلك:
   نخزّن الملف كاملًا (200) مرة واحدة، ثم نقصّ منه الجزء المطلوب هنا. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null) {
    // صيغة اللاحقة: bytes=-N  ⇒ آخر N بايت
    if (end === null || end <= 0) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (!isFinite(start) || !isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

async function rangeFromCache(req) {
  const cached = await caches.match(new Request(req.url), { ignoreVary: true });
  if (!cached) return null;
  const header = req.headers.get("range");
  if (!header) return cached;
  const buf = await cached.arrayBuffer();
  const r = parseRange(header, buf.byteLength);
  if (!r) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${buf.byteLength}` }
    });
  }
  const slice = buf.slice(r.start, r.end + 1);
  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
      "Content-Length": String(slice.byteLength),
      "Content-Range": `bytes ${r.start}-${r.end}/${buf.byteLength}`,
      "Accept-Ranges": "bytes"
    }
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isFont =
    url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  // Google Fonts: cache-first, refresh in background (works offline after first load)
  if (isFont) {
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((r) => { c.put(req, r.clone()); return r; }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // طلب بمدى (الصوت غالبًا): اخدمه من النسخة الكاملة المخزّنة، وإلا من الشبكة بلا تخزين.
  if (req.headers.get("range")) {
    e.respondWith(
      rangeFromCache(req).then((r) => r || fetch(req)).catch(() => fetch(req))
    );
    return;
  }

  // بقيّة الطلبات من نفس المصدر: من التخزين أولًا، ثم الشبكة، ثم هيكل التطبيق.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((r) => {
        // 206/opaque/أخطاء لا تُخزَّن — cache.put يرفضها ويرمي استثناءً.
        if (r.ok && r.status === 200 && r.type === "basic") {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match("./index.html"))
    )
  );
});

/* الصفحة تسأل: هل الصوت مخزَّن؟ */
self.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "audio-status") return;
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.match(new Request(new URL(AUDIO, self.registration.scope).href), { ignoreVary: true }))
      .then((hit) => { if (e.source) e.source.postMessage({ type: "audio-status", cached: !!hit }); })
      .catch(() => { if (e.source) e.source.postMessage({ type: "audio-status", cached: false }); })
  );
});
