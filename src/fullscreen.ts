/**
 * Fullscreen with keyboard lock. In Chromium browsers, locking the keyboard
 * while fullscreen lets the game receive shortcuts the browser would
 * normally swallow — most importantly Ctrl+W (descend + pitch) closing the tab.
 */
type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };

const kb = (): KeyboardLock | undefined => (navigator as unknown as { keyboard?: KeyboardLock }).keyboard;

export const keyboardLockSupported = () => typeof kb()?.lock === 'function';

export async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    kb()?.unlock?.();
    await document.exitFullscreen().catch(() => {});
    return;
  }
  try {
    await document.documentElement.requestFullscreen();
    await kb()?.lock?.();
  } catch {
    /* fullscreen refused (e.g. iframe without permission) */
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) kb()?.unlock?.();
});
