<script lang="ts">
	import type { Props } from '.'

	const {
		size = '24',
		color = 'currentColor',
		viewBox = '0 0 24 24',
		...restProps
	}: Props = $props()
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	fill={color}
	{viewBox}
	{...restProps}
>
	<circle cx="4" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle
		cx="15"
		cy="7"
		r="2"
	/><circle cx="15" cy="12" r="2" /><circle cx="15" cy="17" r="2" /><circle
		cx="20"
		cy="7"
		r="2"
	/><circle cx="4" cy="17" r="2" />
</svg>
