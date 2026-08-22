// PWA glue: service-worker registration + tiny offline badge.
// Imported once from main.ts. All DOM via createElement/textContent.

export function initPWA(): void {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration failures (e.g. non-secure context) are non-fatal */
      });
    });
  }

  const badge = document.createElement("div");
  badge.id = "offline-badge";
  badge.className = "offline-badge";
  badge.textContent = "offline — cached";
  badge.hidden = true;
  document.body.appendChild(badge);

  const update = (): void => {
    badge.hidden = navigator.onLine;
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}
