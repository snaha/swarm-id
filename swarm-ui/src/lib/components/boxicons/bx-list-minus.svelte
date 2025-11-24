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
	<path d="M21.063 15H13v2h9v-2zM4 7h11v2H4zm0 4h11v2H4zm0 4h7v2H4z" />
</svg>
