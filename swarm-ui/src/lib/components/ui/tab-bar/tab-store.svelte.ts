import type { Snippet } from 'svelte'

export type TabStore = {
	selected: number
	readonly items: (string | Snippet)[]
	readonly ids: (string | undefined)[]
	readonly disabled: boolean[]

	addItem: (item: string | Snippet, id: string | undefined, disabled: boolean) => void
	updateDisabled: (item: string | Snippet, disabled: boolean) => void
}

export function withTabStore(): TabStore {
	let selected = $state(0)
	const items: (string | Snippet)[] = $state([])
	const ids: (string | undefined)[] = $state([])
	const disabled: boolean[] = $state([])

	return {
		get selected() {
			return selected
		},
		set selected(newValue) {
			selected = newValue
		},
		items,
		ids,
		disabled,
		addItem(item, id, isDisabled = false) {
			if (items.includes(item)) {
				console.warn(`Duplicate tab item, ignored: ${item}`)
				return
			}
			items.push(item)
			ids.push(id)
			disabled.push(isDisabled)
		},
		updateDisabled(item, isDisabled) {
			const index = items.indexOf(item)
			if (index !== -1) {
				disabled[index] = isDisabled
			}
		},
	}
}
