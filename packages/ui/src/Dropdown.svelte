<script lang="ts" module>
export interface DropdownItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Styled as destructive (delete, revoke). */
  danger?: boolean;
}
</script>

<script lang="ts">
/**
 * A menu of actions behind a button (`@zveltio/ui`). Keyboard and screen-reader
 * behaviour — arrow keys, typeahead, Escape, focus return, `role="menu"` — is
 * `bits-ui`'s; the look is daisyUI's `menu`.
 */
import { DropdownMenu } from 'bits-ui';

let {
  label,
  items,
  triggerClass = 'btn btn-sm',
  align = 'end',
}: {
  /** The trigger's text; also its accessible name. */
  label: string;
  items: DropdownItem[];
  triggerClass?: string;
  align?: 'start' | 'center' | 'end';
} = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class={triggerClass}>{label}</DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {align}
      sideOffset={4}
      class="menu bg-base-100 rounded-box z-50 min-w-40 p-2 shadow-lg"
    >
      {#each items as item (item.label)}
        <DropdownMenu.Item
          disabled={item.disabled}
          onSelect={item.onSelect}
          class={[
            'rounded-field cursor-pointer px-3 py-1.5 text-sm outline-none',
            'data-[highlighted]:bg-base-200 data-[disabled]:opacity-50',
            item.danger && 'text-error',
          ]}
        >
          {item.label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
