// PWA glue: service-worker registration + tiny offline badge.
// Imported once from main.ts. All DOM via createElement/textContent.

export function initPWA(): void {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
        /* registration failures (e.g. non-secure context) are non-fatal */
      });
    });
  }

  const badge = document.createElement("div");
  badge.id = "offline-badge";
  badge.className = "offline-badge";
  badge.textContent = "Offline — only previously opened texts may be available";
  badge.hidden = true;
  document.body.appendChild(badge);

  const update = (): void => {
    badge.hidden = navigator.onLine;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}
