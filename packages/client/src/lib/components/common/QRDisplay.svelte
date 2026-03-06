<script lang="ts">
  import QRCode from 'qrcode';

  interface Props {
    value: string;
    size?: number;
  }

  let { value, size = 200 }: Props = $props();
  let src = $state<string | null>(null);

  $effect(() => {
    QRCode.toDataURL(value, { width: size, margin: 2 }).then((url) => {
      src = url;
    });
  });
</script>

{#if src}
  <img {src} alt="QR Code" width={size} height={size} class="rounded-lg" />
{:else}
  <div class="skeleton" style:width="{size}px" style:height="{size}px"></div>
{/if}
