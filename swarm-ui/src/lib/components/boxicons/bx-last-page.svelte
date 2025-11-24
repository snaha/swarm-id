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
	<path d="M7.707 17.707 13.414 12 7.707 6.293 6.293 7.707 10.586 12l-4.293 4.293zM15 6h2v12h-2z" />
</svg>
