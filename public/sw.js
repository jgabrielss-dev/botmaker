/* Service worker minimo — deixa o painel instalavel na tela inicial (PWA).
   Nao guarda cache: tudo passa direto pela rede para nunca mostrar dados velhos. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // so intercepta GET; o resto (login, salvar fluxo, uploads) segue normal
  if (event.request.method !== 'GET') return;
});
