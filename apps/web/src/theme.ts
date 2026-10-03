export type ThemeChoice = 'light' | 'dark' | 'system'

const KEY = 'divvy-theme'

export function themeChoice(): ThemeChoice {
  const saved = localStorage.getItem(KEY)
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  return 'system'
}

export function resolvedTheme(choice = themeChoice()): 'light' | 'dark' {
  if (choice === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return choice
}

export function applyTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = resolvedTheme(choice)
  window.dispatchEvent(new Event('divvy-theme'))
}

export function chooseTheme(choice: ThemeChoice) {
  localStorage.setItem(KEY, choice)
  applyTheme(choice)
}

export function installTheme() {
  applyTheme(themeChoice())
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeChoice() === 'system') applyTheme('system')
  })
}
