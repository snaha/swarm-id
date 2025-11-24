import type { SVGAttributes } from 'svelte/elements'

export interface Props extends SVGAttributes<SVGElement> {
	size?: number | string
	color?: string
}
