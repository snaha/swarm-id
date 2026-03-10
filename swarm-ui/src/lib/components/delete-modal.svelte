<script lang="ts">
  import Button from './ui/button.svelte'
  import Modal, { type ModalProps } from './ui/modal.svelte'
  import Typography from './ui/typography.svelte'
  import Close from 'carbon-icons-svelte/lib/Close.svelte'
  import LoaderButton from './loader-button.svelte'

  type Props = {
    confirm: () => void
    title: string
    text: string
    buttonTitle: string
    cancelTitle?: string
  }
  let {
    oncancel,
    confirm,
    open = $bindable(false),
    title,
    text,
    buttonTitle,
    cancelTitle = "Don't delete",
    ...restProps
  }: ModalProps & Props = $props()
</script>

<Modal {oncancel} bind:open {...restProps}>
  <section class="dialog">
    <header class="horizontal">
      <Typography variant="h5">{title}</Typography>
      <div class="grower"></div>
      <Button variant="ghost" dimension="compact" onclick={oncancel}><Close size={24} /></Button>
    </header>

    {#if text}
      <Typography>{text}</Typography>
    {/if}
    <section class="buttons">
      <LoaderButton variant="strong" dimension="compact" onclick={confirm} class="danger-button"
        >{buttonTitle}</LoaderButton
      >
      <Button variant="ghost" dimension="compact" onclick={oncancel}>{cancelTitle}</Button>
      <div class="grower"></div>
    </section>
  </section>
</Modal>

<style lang="postcss">
  .dialog {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--one-and-half-padding);
    background-color: var(--colors-ultra-low);
    padding: var(--one-and-half-padding);
    height: 100%;
  }
  .horizontal {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--half-padding);
  }
  .buttons {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--half-padding);
  }
  :global(.danger-button button) {
    background: var(--colors-red) !important;
    border-color: transparent !important;
    color: var(--colors-base) !important;
  }
  @media screen and (max-width: 624px) {
    .buttons {
      flex-direction: column-reverse;
      align-items: stretch;
    }
  }
  .grower {
    flex-grow: 1;
  }
</style>
