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
	<circle cx="6.5" cy="6.5" r="2.5" /><path d="m14 7-5.223 8.487L7 13l-5 7h20z" />
</svg>
