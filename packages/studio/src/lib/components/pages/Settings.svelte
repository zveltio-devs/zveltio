<script lang="ts">
	/**
	 * SettingsPage - User preferences management
	 * Handles: theme, navbar position, display preferences
	 */
	interface Preferences {
		theme?: string;
		navbar_position?: 'top' | 'bottom' | 'left' | 'right';
		nav_collapsed?: boolean;
	}

	let {
		preferences = $bindable<Preferences>({}),
		onSave,
		saving = false
	}: {
		preferences?: Preferences;
		onSave: (prefs: Preferences) => Promise<void>;
		saving?: boolean;
	} = $props();

	let localPrefs = $state<Preferences>({ ...preferences });
	let hasChanges = $derived(
		JSON.stringify(localPrefs) !== JSON.stringify(preferences)
	);

	async function handleSave() {
		await onSave(localPrefs);
	}

	function handleReset() {
		localPrefs = { ...preferences };
	}
</script>

<div class="max-w-4xl mx-auto space-y-6">
	<div>
		<h1 class="text-3xl font-bold">Settings</h1>
		<p class="text-sm opacity-60 mt-1">Manage your account preferences</p>
	</div>

	<!-- Appearance Section -->
	<div class="card bg-base-100 border border-base-200">
		<div class="card-body">
			<h2 class="card-title">Appearance</h2>

			<div class="form-control">
				<label class="label">
					<span class="label-text">Theme</span>
				</label>
				<select bind:value={localPrefs.theme} class="select select-bordered">
					<option value="light">Light</option>
					<option value="dark">Dark</option>
					<option value="auto">Auto (System)</option>
				</select>
			</div>

			<div class="form-control mt-4">
				<label class="label">
					<span class="label-text">Navbar Position</span>
				</label>
				<div class="grid grid-cols-2 gap-3">
					{#each ['top', 'bottom', 'left', 'right'] as pos}
						<label class="cursor-pointer">
							<input
								type="radio"
								bind:group={localPrefs.navbar_position}
								value={pos}
								class="radio radio-primary"
							/>
							<span class="ml-2 capitalize">{pos}</span>
						</label>
					{/each}
				</div>
				<label class="label">
					<span class="label-text-alt">Changes apply immediately after saving</span>
				</label>
			</div>
		</div>
	</div>

	<!-- Navigation Section -->
	<div class="card bg-base-100 border border-base-200">
		<div class="card-body">
			<h2 class="card-title">Navigation</h2>

			<div class="form-control">
				<label class="label cursor-pointer justify-start gap-3">
					<input
						type="checkbox"
						bind:checked={localPrefs.nav_collapsed}
						class="toggle toggle-primary"
					/>
					<span class="label-text">Collapse sidebar by default</span>
				</label>
			</div>
		</div>
	</div>

	<!-- Preview Section -->
	<div class="card bg-base-100 border border-base-200">
		<div class="card-body">
			<h2 class="card-title">Preview</h2>
			<div class="relative h-40 bg-base-200 rounded-lg overflow-hidden">
				<!-- Navbar Preview -->
				{#if localPrefs.navbar_position === 'top'}
					<div class="absolute top-0 left-0 right-0 h-12 bg-primary flex items-center justify-center text-primary-content text-xs">
						Navbar (Top)
					</div>
				{:else if localPrefs.navbar_position === 'bottom'}
					<div class="absolute bottom-0 left-0 right-0 h-12 bg-primary flex items-center justify-center text-primary-content text-xs">
						Navbar (Bottom)
					</div>
				{:else if localPrefs.navbar_position === 'left'}
					<div class="absolute top-0 bottom-0 left-0 w-16 bg-primary flex items-center justify-center text-primary-content text-xs writing-vertical">
						<span class="rotate-90">Navbar</span>
					</div>
				{:else if localPrefs.navbar_position === 'right'}
					<div class="absolute top-0 bottom-0 right-0 w-16 bg-primary flex items-center justify-center text-primary-content text-xs">
						<span class="rotate-90">Navbar</span>
					</div>
				{/if}

				<!-- Content Area -->
				<div class="absolute inset-0 flex items-center justify-center text-xs opacity-50">
					Content Area
				</div>
			</div>
		</div>
	</div>

	<!-- Actions -->
	<div class="flex justify-end gap-3 sticky bottom-4 bg-base-100 p-4 rounded-lg shadow-lg border border-base-200">
		<button
			class="btn btn-ghost"
			onclick={handleReset}
			disabled={!hasChanges || saving}
		>
			Reset
		</button>
		<button
			class="btn btn-primary"
			onclick={handleSave}
			disabled={!hasChanges || saving}
		>
			{#if saving}
				<span class="loading loading-spinner loading-sm"></span>
				Saving...
			{:else}
				Save Changes
			{/if}
		</button>
	</div>
</div>
