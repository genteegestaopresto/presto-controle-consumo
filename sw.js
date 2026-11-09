/* Service worker: guarda todos os arquivos do app no celular para funcionar sem internet.
   Ao publicar uma nova versão, aumente o número em VERSAO. */
const VERSAO = 'presto-consumo-v6';
const ARQUIVOS = [
  './', 'index.html', 'styles.css', 'app.js', 'jsQR.js', 'qrcode.js', 'manifest.json',
  'logo-branco.png', 'icon-192.png', 'icon-512.png',
  'Kanit-SemiBold-latin.woff2', 'Barlow-Regular-latin.woff2', 'Barlow-Medium-latin.woff2',
  'Barlow-SemiBold-latin.woff2', 'BarlowSemiCondensed-Regular-latin.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // sincronização com o Google passa direto
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { ignoreSearch: true }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
