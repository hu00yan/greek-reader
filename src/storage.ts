/** Reading must work even when storage is blocked or full. Session fallback
 * preserves settings without pretending that they survived a browser restart. */
const memory = new Map<string, string>();
export const storage = {
  getItem(key: string): string | null {
    if (memory.has(key)) return memory.get(key)!;
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    try { localStorage.setItem(key, value); }
    catch { window.dispatchEvent(new Event("storage-unavailable")); }
  },
};
