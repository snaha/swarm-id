export interface SelectStore {
	value?: string
	labels: Record<string, string>
	open: boolean
	size: Size
	marked?: string
	changed: boolean
	registerValue(value: string, label?: string): void
}
type Size = 'default' | 'large' | 'compact' | 'small'
export function withSelectStore(dimension: Size, initialValue?: string): SelectStore {
	let value = $state<string | undefined>(initialValue)
	let size = $state<Size>(dimension)
	let labels = $state<Record<string, string>>({})
	let open = $state(false)
	let marked = $state<string | undefined>(initialValue)
	let changed = $state(false)

	function registerValue(newValue: string, newLabel?: string) {
		if (labels[newValue]) return

		labels[newValue] = newLabel ?? newValue
	}

	return {
		get value() {
			return value
		},
		set value(newValue) {
			value = newValue
		},
		get size() {
			return size
		},
		set size(newValue) {
			size = newValue
		},
		get labels() {
			return labels
		},
		set labels(newValue) {
			labels = newValue
		},
		get open() {
			return open
		},
		set open(newValue) {
			open = newValue
		},
		get marked() {
			return marked
		},
		set marked(newValue) {
			marked = newValue
		},
		get changed() {
			return changed
		},
		set changed(newValue) {
			changed = newValue
		},
		registerValue,
	}
}
