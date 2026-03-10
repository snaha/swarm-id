<script lang="ts">
  import CreateNewAccount from '$lib/components/create-new-account.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
</script>

<Vertical --vertical-gap="16px">
  <Vertical --vertical-gap="0px">
    <Typography variant="h4">Sign up for Swarm ID</Typography>
    <Typography>Create your Swarm ID account with Ethereum or Passkey</Typography>
  </Vertical>
  <CreateNewAccount />
</Vertical>
