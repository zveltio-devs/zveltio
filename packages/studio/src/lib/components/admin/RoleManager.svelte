<script lang="ts">
	/**
	 * RoleManager - RBAC role management UI
	 * Standalone, callback-based
	 */
	
	interface Role {
		id: string;
		name: string;
		description: string;
		allowed_for: 'INTERNAL' | 'PARTNER';
		parent_role_id?: string | null;
	}
	
	let {
		roles = [],
		onSave,
		onDelete
	}: {
		roles: Role[];
		onSave: (role: Omit<Role, 'id'> | Role) => Promise<void>;
		onDelete: (roleId: string) => Promise<void>;
	} = $props();

	let isModalOpen = $state(false);
	let editingRole = $state<Partial<Role> | null>(null);
	let saving = $state(false);

	function openNew() {
		editingRole = {
			name: '',
			description: '',
			allowed_for: 'INTERNAL',
			parent_role_id: null
		};
		isModalOpen = true;
	}

	function openEdit(role: Role) {
		editingRole = { ...role };
		isModalOpen = true;
	}

	async function handleSave() {
		if (!editingRole) return;
		saving = true;
		try {
			await onSave(editingRole as Role);
			isModalOpen = false;
			editingRole = null;
		} finally {
			saving = false;
		}
	}

	async function handleDelete(roleId: string) {
		if (!confirm('Delete this role?')) return;
		await onDelete(roleId);
	}
</script>

<div class="p-4">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-2xl font-bold">Roles</h2>
		<button class="btn btn-primary" onclick={openNew}>
			+ New Role
		</button>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each roles as role}
			<div class="card bg-base-100 border border-base-200 shadow-sm hover:shadow-md transition">
				<div class="card-body p-4">
					<div class="flex items-start justify-between">
						<div class="flex items-center gap-2">
							<div class="avatar placeholder">
								<div class="w-10 rounded-full bg-primary text-primary-content">
									<span class="text-sm">{role.name.substring(0, 2).toUpperCase()}</span>
								</div>
							</div>
							<div>
								<h3 class="font-bold">{role.name}</h3>
								<span class="badge badge-xs {role.allowed_for === 'INTERNAL' ? 'badge-primary' : 'badge-secondary'}">
									{role.allowed_for}
								</span>
							</div>
						</div>
						<div class="dropdown dropdown-end">
							<button tabindex="0" class="btn btn-ghost btn-xs btn-square">
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
								</svg>
							</button>
							<ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-32">
								<li><button onclick={() => openEdit(role)}>Edit</button></li>
								<li><button class="text-error" onclick={() => handleDelete(role.id)}>Delete</button></li>
							</ul>
						</div>
					</div>

					<p class="text-sm opacity-70 mt-2">{role.description || '—'}</p>

					{#if role.parent_role_id}
						<div class="text-xs text-info mt-2">
							Parent: {roles.find(r => r.id === role.parent_role_id)?.name || 'Unknown'}
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>

<!-- Modal -->
{#if isModalOpen && editingRole}
	<dialog class="modal modal-open">
		<div class="modal-box">
			<h3 class="font-bold text-lg mb-4">{editingRole.id ? 'Edit' : 'Create'} Role</h3>

			<div class="space-y-3">
				<div class="form-control">
					<label class="label"><span class="label-text">Name</span></label>
					<input
						type="text"
						bind:value={editingRole.name}
						class="input input-bordered"
						placeholder="Administrator"
					/>
				</div>

				<div class="form-control">
					<label class="label"><span class="label-text">Type</span></label>
					<select bind:value={editingRole.allowed_for} class="select select-bordered">
						<option value="INTERNAL">Internal (Employee)</option>
						<option value="PARTNER">Partner (External)</option>
					</select>
				</div>

				<div class="form-control">
					<label class="label"><span class="label-text">Parent Role</span></label>
					<select bind:value={editingRole.parent_role_id} class="select select-bordered">
						<option value={null}>— None (Top Level) —</option>
						{#each roles.filter(r => r.id !== editingRole?.id) as r}
							<option value={r.id}>{r.name}</option>
						{/each}
					</select>
				</div>

				<div class="form-control">
					<label class="label"><span class="label-text">Description</span></label>
					<textarea
						bind:value={editingRole.description}
						class="textarea textarea-bordered"
						placeholder="Role description..."
					></textarea>
				</div>
			</div>

			<div class="modal-action">
				<button class="btn" onclick={() => isModalOpen = false} disabled={saving}>Cancel</button>
				<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
					{#if saving}Saving...{:else}Save{/if}
				</button>
			</div>
		</div>
	</dialog>
{/if}
