/* Service worker minimo — deixa o painel instalavel na tela inicial (PWA).
   O painel roda no proprio aparelho (localhost), entao a rede local nao e o
   problema: guardamos em cache apenas o Tailwind (CDN externo) para a tela
   continuar estilizada mesmo sem internet. Nada de dados do painel e cacheados. */
const CACHE = 'painel-shell-v1';
const CDN = 'https://cdn.tailwindcss.com';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(CDN).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // so intercepta GET
  if (req.method !== 'GET') return;
  // apenas o Tailwind (CDN) usa cache; o resto passa direto para nunca mostrar dados velhos
  if (req.url === CDN) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
              return res;
            })
            .catch(() => hit)
      )
    );
  }
});
