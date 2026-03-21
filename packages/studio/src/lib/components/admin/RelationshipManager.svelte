<script lang="ts">
 interface Constraint {
 constraint_type: string;
 constraint_name: string;
 column_name?: string;
 foreign_table?: string;
 foreign_column?: string;
 definition?: string;
 }

 let {
 tableName,
 constraints = [],
 }: { tableName: string; constraints: Constraint[] } = $props();

 const foreignKeys = $derived(constraints.filter((c) => c.constraint_type === 'FOREIGN KEY'));
 const uniqueConstraints = $derived(constraints.filter((c) => c.constraint_type === 'UNIQUE'));
 const checkConstraints = $derived(constraints.filter((c) => c.constraint_type === 'CHECK'));
</script>

<div class="space-y-4">
 <div class="flex items-center gap-2">
 <h3 class="font-semibold">Relationships & Constraints</h3>
 <span class="badge badge-sm">{constraints.length}</span>
 </div>

 {#if foreignKeys.length > 0}
 <div>
 <h4 class="text-xs uppercase font-bold opacity-50 mb-2">Foreign Keys ({foreignKeys.length})</h4>
 <div class="space-y-2">
 {#each foreignKeys as fk}
 <div class="p-3 bg-base-200 rounded-lg">
 <div class="font-mono text-sm font-bold">{fk.constraint_name}</div>
 {#if fk.column_name && fk.foreign_table}
 <div class="text-xs opacity-60 mt-1">
 <span class="font-mono">{fk.column_name}</span> → <span class="font-mono">{fk.foreign_table}.{fk.foreign_column}</span>
 </div>
 {:else if fk.definition}
 <div class="text-xs opacity-60 mt-1">{fk.definition}</div>
 {/if}
 </div>
 {/each}
 </div>
 </div>
 {/if}

 {#if uniqueConstraints.length > 0}
 <div>
 <h4 class="text-xs uppercase font-bold opacity-50 mb-2">Unique Constraints ({uniqueConstraints.length})</h4>
 <div class="space-y-2">
 {#each uniqueConstraints as uc}
 <div class="p-3 bg-base-200 rounded-lg">
 <div class="font-mono text-sm">{uc.constraint_name}</div>
 {#if uc.column_name}<div class="text-xs opacity-60 mt-1">{uc.column_name}</div>{/if}
 </div>
 {/each}
 </div>
 </div>
 {/if}

 {#if checkConstraints.length > 0}
 <div>
 <h4 class="text-xs uppercase font-bold opacity-50 mb-2">Check Constraints ({checkConstraints.length})</h4>
 <div class="space-y-2">
 {#each checkConstraints as cc}
 <div class="p-3 bg-base-200 rounded-lg">
 <div class="font-mono text-sm">{cc.constraint_name}</div>
 {#if cc.definition}<div class="text-xs opacity-60 mt-1">{cc.definition}</div>{/if}
 </div>
 {/each}
 </div>
 </div>
 {/if}

 {#if constraints.length === 0}
 <div class="text-center py-8 text-sm opacity-50">No constraints defined for <code>{tableName}</code></div>
 {/if}
</div>
