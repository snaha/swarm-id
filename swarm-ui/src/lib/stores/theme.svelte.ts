import { browser } from '$app/environment'

const STORAGE_KEY = 'swarm-id-theme'

export type ThemePreference = 'light' | 'dark' | 'auto'

export interface ThemeStore {
	preference: ThemePreference
}

function withThemeStore(): ThemeStore {
	let preference = $state<ThemePreference>(readPreference())

	if (browser) {
		const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
		mediaQuery.addEventListener('change', () => {
			if (preference === 'auto') {
				applyTheme(preference)
			}
		})
	}

	function readPreference(): ThemePreference {
		if (!browser) return 'auto'
		const stored = localStorage.getItem(STORAGE_KEY)
		if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
		return 'auto'
	}

	function applyTheme(pref: ThemePreference) {
		const dark =
			pref === 'dark' ||
			(pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
		document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
		document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
	}

	return {
		get preference() {
			return preference
		},
		set preference(value: ThemePreference) {
			preference = value
			applyTheme(preference)
			localStorage.setItem(STORAGE_KEY, preference)
		},
	}
}

export const themeStore = withThemeStore()
