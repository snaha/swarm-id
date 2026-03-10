<script lang="ts">
  import { Alert, AlertDescription } from '$lib/components/ui/alert'
  import type { ResultData } from './result-types'

  interface Props {
    result?: ResultData
    error?: string
    class?: string
  }

  let { result, error, class: className }: Props = $props()
</script>

{#if error}
  <Alert variant="destructive" class={className}>
    <AlertDescription>
      <strong>Error:</strong>
      {error}
    </AlertDescription>
  </Alert>
{:else if result}
  <Alert class={className}>
    <AlertDescription>
      <div class="font-mono text-xs break-all whitespace-pre-wrap space-y-1">
        <strong
          class={result.titleVariant === 'success'
            ? 'text-success'
            : result.titleVariant === 'warning'
              ? 'text-warning'
              : ''}>{result.title}</strong
        >
        {#if result.entries}
          {#each result.entries as entry, i (i)}
            <div>
              {#if entry.label}<strong>{entry.label}:</strong>
              {/if}{entry.value}
            </div>
          {/each}
        {/if}
        {#if result.code}
          <pre
            class={result.codeDark
              ? 'mt-1 p-2 rounded bg-[#2d2d2d] text-gray-200 text-xs overflow-x-auto whitespace-pre-wrap break-all'
              : 'mt-2 max-h-[200px] overflow-auto bg-muted p-2 text-xs rounded'}>{result.code}</pre>
        {/if}
        {#if result.status}
          <div
            class={result.statusVariant === 'success'
              ? 'text-success'
              : result.statusVariant === 'warning'
                ? 'text-warning'
                : ''}
          >
            {result.status}
          </div>
        {/if}
        {#if result.footnote}
          <div class="text-xs italic text-muted-foreground">{result.footnote}</div>
        {/if}
      </div>
    </AlertDescription>
  </Alert>
{/if}
