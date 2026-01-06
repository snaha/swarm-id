<script lang="ts">
	import CreateNewAccount from '$lib/components/create-new-account.svelte'
	import Vertical from '$lib/components/ui/vertical.svelte'
	import Typography from '$lib/components/ui/typography.svelte'
</script>

<Vertical>
	<Typography variant="h4">Create New Account</Typography>
	<Typography variant="small">Create or import an account to continue</Typography>
	<CreateNewAccount />
</Vertical>
