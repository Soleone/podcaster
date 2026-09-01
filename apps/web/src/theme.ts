export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'podcaster-theme';

export function readTheme(): Theme {
  if (!globalThis.window) return 'dark';
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  if (!globalThis.document) return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function persistTheme(theme: Theme): void {
  applyTheme(theme);
  if (!globalThis.window) return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The visual preference still applies when storage is unavailable.
  }
}
