/**
 * The themes, and the one place that knows how to apply one.
 *
 * A theme is nothing but a block of custom properties in styles.css keyed on
 * `data-theme`. No component reads a colour by name, so adding one here and a
 * block there is the whole change, and it cannot break a layout.
 *
 * `system` is the absence of the attribute rather than a value of it, which is
 * what lets the `prefers-color-scheme` block in styles.css apply at all.
 */

export interface Theme {
  id: string;
  name: string;
  /** One line, for the picker. What it is for, not what colour it is. */
  note: string;
}

export const THEMES: readonly Theme[] = [
  { id: 'system', name: 'System', note: 'Follows whatever this machine is set to.' },
  { id: 'light', name: 'Light', note: 'The default. A bright bench, a bright screen.' },
  { id: 'dark', name: 'Dark', note: 'Neutral dark, for a dim room.' },
  { id: 'sepia', name: 'Sepia', note: 'Warm paper, without the blue-white glare.' },
  { id: 'midnight', name: 'Midnight', note: 'Deep blue-black, for working late.' },
  { id: 'terminal', name: 'Terminal', note: 'Cold green on near-black. The incubator room at 11pm.' },
  { id: 'contrast', name: 'High contrast', note: 'Heavier text and borders, for a projector or bright light.' },
] as const;

export const THEME_KEY = 'protracker:theme';

export function storedTheme(): string {
  const saved = window.localStorage.getItem(THEME_KEY);
  return THEMES.some((theme) => theme.id === saved) ? saved! : 'system';
}

export function applyTheme(id: string): void {
  const root = document.documentElement;
  if (id === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = id;
  window.localStorage.setItem(THEME_KEY, id);
}

/**
 * The next theme along, for the topbar button.
 *
 * The button used to be a light/dark toggle and the muscle memory for it is
 * "press this until the screen looks right", which cycling preserves.
 */
export function nextTheme(current: string): string {
  const index = THEMES.findIndex((theme) => theme.id === current);
  return THEMES[(index + 1) % THEMES.length]!.id;
}

/** Whether a theme paints a dark surface — the topbar icon asks. */
export function isDark(id: string): boolean {
  if (id === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }
  return id === 'dark' || id === 'midnight' || id === 'terminal';
}
