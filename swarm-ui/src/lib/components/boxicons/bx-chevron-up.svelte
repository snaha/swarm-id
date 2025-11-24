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
	<path d="m6.293 13.293 1.414 1.414L12 10.414l4.293 4.293 1.414-1.414L12 7.586z" />
</svg>
