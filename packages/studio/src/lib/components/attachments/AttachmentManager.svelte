<script lang="ts">
	/**
	 * AttachmentManager - File upload/management component
	 * Standalone, works with any storage backend
	 */
	
	interface FileItem {
		id: string;
		name: string;
		size: number;
		type: string;
		url?: string;
		created_at: string;
	}
	
	let {
		files = [],
		onUpload,
		onDelete,
		onDownload = null,
		acceptedTypes = '*',
		readOnly = false,
		maxFiles = 10
	}: {
		files: FileItem[];
		onUpload: (files: FileList) => Promise<void>;
		onDelete: (fileId: string) => Promise<void>;
		onDownload?: ((fileId: string) => void) | null;
		acceptedTypes?: string;
		readOnly?: boolean;
		maxFiles?: number;
	} = $props();

	let uploading = $state(false);
	let dragOver = $state(false);
	let fileInput: HTMLInputElement;

	function formatSize(bytes: number): string {
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	function getFileIcon(type: string): string {
		if (type.startsWith('image/')) return '🖼️';
		if (type.startsWith('video/')) return '🎥';
		if (type.startsWith('audio/')) return '🎵';
		if (type.includes('pdf')) return '📄';
		if (type.includes('zip') || type.includes('rar')) return '📦';
		return '📁';
	}

	async function handleUpload(fileList: FileList | null) {
		if (!fileList || fileList.length === 0 || readOnly) return;
		
		if (files.length + fileList.length > maxFiles) {
			alert(`Maximum ${maxFiles} files allowed`);
			return;
		}

		uploading = true;
		try {
			await onUpload(fileList);
		} finally {
			uploading = false;
		}
	}

	async function handleDelete(fileId: string) {
		if (!confirm('Delete this file?')) return;
		await onDelete(fileId);
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files) {
			handleUpload(e.dataTransfer.files);
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}
</script>

<div class="space-y-4">
	<!-- Upload Area -->
	{#if !readOnly}
		<div
			class="border-2 border-dashed rounded-lg p-8 text-center transition {dragOver ? 'border-primary bg-primary/5' : 'border-base-300'}"
			ondrop={handleDrop}
			ondragover={handleDragOver}
			ondragleave={() => dragOver = false}
		>
			<input
				bind:this={fileInput}
				type="file"
				multiple
				accept={acceptedTypes}
				onchange={(e) => handleUpload(e.currentTarget.files)}
				class="hidden"
			/>
			
			{#if uploading}
				<div class="flex flex-col items-center gap-2">
					<svg class="animate-spin h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					<span class="text-sm">Uploading...</span>
				</div>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 mx-auto mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
				</svg>
				<p class="text-sm mb-2">Drag & drop files or click to browse</p>
				<button class="btn btn-sm btn-primary" onclick={() => fileInput.click()}>
					Choose Files
				</button>
			{/if}
		</div>
	{/if}

	<!-- Files List -->
	{#if files.length > 0}
		<div class="space-y-2">
			{#each files as file}
				<div class="card bg-base-100 border border-base-200">
					<div class="card-body p-4 flex-row items-center gap-4">
						<!-- Icon -->
						<div class="text-3xl">{getFileIcon(file.type)}</div>

						<!-- Info -->
						<div class="flex-1 min-w-0">
							<p class="font-medium truncate">{file.name}</p>
							<p class="text-sm opacity-60">{formatSize(file.size)} • {new Date(file.created_at).toLocaleDateString()}</p>
						</div>

						<!-- Actions -->
						<div class="flex gap-2">
							{#if onDownload}
								<button
									class="btn btn-sm btn-ghost btn-square"
									onclick={() => onDownload?.(file.id)}
									title="Download"
								>
									<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
									</svg>
								</button>
							{/if}
							{#if !readOnly}
								<button
									class="btn btn-sm btn-ghost btn-square text-error"
									onclick={() => handleDelete(file.id)}
									title="Delete"
								>
									<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
									</svg>
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-center py-8 text-sm opacity-50">
			No files uploaded yet
		</div>
	{/if}
</div>
