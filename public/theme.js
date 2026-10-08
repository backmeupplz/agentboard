// Loaded synchronously in <head> so the right palette is set before first paint (inline scripts are blocked by the CSP).
// localStorage.theme is 'light', 'dark' or unset (follow the OS). app.js owns the toggle button.
{
  const os = matchMedia('(prefers-color-scheme: light)')
  const saved = () => { try { return localStorage.getItem('theme') } catch { return null } }
  const apply = () => { document.documentElement.dataset.theme = saved() || (os.matches ? 'light' : 'dark') }
  apply(); os.addEventListener('change', apply); window.applyTheme = apply
}
