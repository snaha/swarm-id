import { browser } from '$app/environment'

export interface LayoutStore {
	mobile: boolean
}

function withLayoutStore(): LayoutStore {
	let mobile = $state(checkMobile())

	if (browser) {
		window.addEventListener('resize', () => {
			mobile = checkMobile()
		})
	}

	function checkMobile() {
		return browser && window.innerWidth < 1024
	}

	return {
		get mobile() {
			return mobile
		},
		set mobile(value: boolean) {
			mobile = value
		},
	}
}

export const layoutStore = withLayoutStore()
