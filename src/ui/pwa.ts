/**
 * Progressive web app plumbing: install the service worker, and hold the
 * screen awake while a transfer is running.
 *
 * The wake lock is not a polish item. A transfer is one device showing a
 * screen and another filming it, and neither is being touched while it runs —
 * which is exactly the condition every phone treats as "idle, dim the
 * display". The sender going dark stalls the link; the receiver going dark
 * ends it.
 */

/**
 * Register the service worker. Production only: in development the dev server
 * serves modules that change constantly, and a cache sitting in front of them
 * causes more confusion than it saves.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/';
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .catch(() => {
        // Offline support is an enhancement; failing to register it must never
        // take the page down with it.
      });
  });
}

/**
 * Keeps the screen on for as long as it is held.
 *
 * The lock is dropped automatically whenever the page is hidden — switching
 * apps, locking the phone — and is not restored on return, so coming back to
 * a tab has to re-acquire it or the screen starts dimming again mid-transfer.
 */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private listening = false;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  async acquire(): Promise<boolean> {
    this.wanted = true;
    this.listen();
    return this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) {
      try {
        await s.release();
      } catch {
        /* already gone */
      }
    }
  }

  private async request(): Promise<boolean> {
    if (!this.supported) return false;
    if (this.held) return true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
      this.sentinel = sentinel;
      return true;
    } catch {
      // Denied, or the document was not visible at the time. Not fatal — the
      // transfer still works, the screen just may dim.
      return false;
    }
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') void this.request();
    });
  }
}
