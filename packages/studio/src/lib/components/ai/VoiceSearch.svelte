<script lang="ts">
	let {
		onTranscript,
		onSearch = null
	}: {
		onTranscript: (text: string) => void;
		onSearch?: ((text: string) => Promise<void>) | null;
	} = $props();

	let listening = $state(false);
	let transcript = $state('');
	let error = $state('');

	function startListening() {
		if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
			error = 'Speech recognition not supported';
			return;
		}

		const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
		const recognition = new SpeechRecognition();
		
		recognition.continuous = false;
		recognition.interimResults = false;
		recognition.lang = 'en-US';

		recognition.onstart = () => {
			listening = true;
			error = '';
		};

		recognition.onresult = (event: any) => {
			const text = event.results[0][0].transcript;
			transcript = text;
			onTranscript(text);
			if (onSearch) onSearch(text);
		};

		recognition.onerror = (event: any) => {
			error = event.error;
			listening = false;
		};

		recognition.onend = () => {
			listening = false;
		};

		recognition.start();
	}
</script>

<div class="flex items-center gap-2">
	<button
		class="btn btn-circle {listening ? 'btn-error animate-pulse' : 'btn-ghost'}"
		onclick={startListening}
		disabled={listening}
		title="Voice search"
	>
		<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
		</svg>
	</button>
	
	{#if listening}
		<span class="text-sm opacity-60">Listening...</span>
	{:else if transcript}
		<span class="text-sm">{transcript}</span>
	{/if}

	{#if error}
		<span class="text-sm text-error">{error}</span>
	{/if}
</div>
