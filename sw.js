/* ══════════════════════════════════════════════════════════════════
   SERVICE WORKER — Clinique Haba
   Rend l'application utilisable 100% hors-ligne après une première
   visite en ligne : met en cache la page elle-même, les polices, et
   les librairies (Firebase SDK, html2canvas, jsPDF, qrcode).

   Stratégie :
   - App shell (le fichier HTML) : "network first, fallback cache" —
     essaie d'avoir la dernière version si en ligne, sert le cache sinon.
   - Librairies externes (CDN) : "cache first" — une fois téléchargées,
     jamais besoin de réseau pour elles.
   Les données patients (Firestore) NE PASSENT PAS par ce cache : elles
   sont gérées par la persistance offline native de Firestore.
══════════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'clinique-haba-v1';

// Fichiers/URLs à mettre en cache dès l'installation du Service Worker.
const PRECACHE_URLS = [
  './',
  './cliniquehaba.html',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@700;900&family=Nunito:wght@400;600;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll échoue en bloc si une seule requête échoue ; on préfère
      // tenter chaque fichier individuellement pour ne pas bloquer
      // l'installation entière si un CDN est temporairement injoignable.
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, {mode: url.startsWith('http') ? 'cors' : 'same-origin'}))
            .catch((err) => console.warn('[SW] Précache échoué pour', url, err))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // On ne touche jamais aux requêtes vers Firestore/Firebase (API de
  // données) : Firestore gère lui-même son propre cache/queue offline,
  // et intercepter ces requêtes ici créerait des conflits.
  if (req.url.includes('firestore.googleapis.com') ||
      req.url.includes('firebaseinstallations.googleapis.com')) {
    return;
  }

  const isAppShell = req.mode === 'navigate' || req.url.endsWith('cliniquehaba.html');

  if (isAppShell) {
    // Network-first pour la page principale : on veut la dernière
    // version dès que possible, mais on retombe sur le cache si offline.
    event.respondWith(
      fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      }).catch(() =>
        caches.match(req).then((cached) => cached || caches.match('./cliniquehaba.html'))
      )
    );
    return;
  }

  // Cache-first pour tout le reste (polices, librairies CDN) : une fois
  // en cache, plus jamais besoin de réseau pour ces fichiers statiques.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Ne met en cache que les réponses valides (évite de stocker
        // des erreurs 404/opaques indéfiniment).
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        }
        return res;
      }).catch(() => cached); // dernier recours : rien à faire si ni cache ni réseau
    })
  );
});
