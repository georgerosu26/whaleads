export type Theme = 'light' | 'dark'
const KEY = 'wl_theme'

export function getTheme(): Theme {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}
export function applyTheme(t: Theme) {
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
  else document.documentElement.removeAttribute('data-theme')
}
export function setTheme(t: Theme) {
  applyTheme(t)
  try { localStorage.setItem(KEY, t) } catch { /* storage blocked: the choice lasts for this tab only */ }
}
