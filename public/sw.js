/* Ümraniye Şampiyonları — servis çalışanı: uygulama kabuğu ve telefon bildirimleri */
const CACHE = 'us-v6';
const APP = 'Ümraniye Şampiyonları';
const SHELL = ['/', '/icon.svg', '/icon-192.png', '/manifest.webmanifest', '/vendor/qrcode.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/takip/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => caches.match(req)));
});

/* bildirim geldi */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: APP, body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // Uygulama şu an ekranda ve önde ise mesaj/arama uygulamanın içinde gösterilir, ayrıca bildirim çıkmaz
    if (d.kind === 'chat' || d.kind === 'call') {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some(w => w.focused && w.visibilityState === 'visible')) return;
    }
    const opt = {
      body: d.body || '', icon: '/icon-192.png', badge: '/icon-192.png', lang: 'tr',
      tag: d.tag || undefined, renotify: !!d.tag, timestamp: Date.now(),
      data: { url: d.url || '/', kind: d.kind || '', room: d.room || '', answerUrl: d.answerUrl || '' },
    };
    if (d.kind === 'call') {
      opt.requireInteraction = true;
      opt.vibrate = [700, 300, 700, 300, 700, 300, 700];
      opt.actions = [{ action: 'answer', title: d.video ? 'Görüntülü cevapla' : 'Cevapla' }, { action: 'decline', title: 'Reddet' }];
    } else if (d.kind === 'call-missed') {
      opt.vibrate = [200, 100, 200];
    } else {
      opt.vibrate = [180, 80, 180];
    }
    await self.registration.showNotification(d.title || APP, opt);
  })());
});

async function openUrl(url) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if ('focus' in w) {
      try { if ('navigate' in w) await w.navigate(url); } catch (_) { /* kontrol dışı pencere */ }
      return w.focus();
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', e => {
  const n = e.notification; const d = n.data || {};
  n.close();
  if (e.action === 'decline' && d.room) {
    e.waitUntil(fetch('/api/call/ring/end', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: d.room, reason: 'declined' }) }).catch(() => {}));
    return;
  }
  const url = (e.action === 'answer' && d.answerUrl) ? d.answerUrl : (d.url || '/');
  e.waitUntil(openUrl(url));
});

/* tarayıcı aboneliği yenilerse sunucuya yeniden bildir */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey;
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch (_) { /* bir sonraki girişte uygulama yeniden abone olur */ }
  })());
});
