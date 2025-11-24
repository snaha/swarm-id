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
	<path d="M10 7h4v4h-4zm6 0h4v4h-4zM4 7h4v4H4zm6 6h4v4h-4zm6 0h4v4h-4zM4 13h4v4H4z" />
</svg>
