import { join } from 'node:path';

/**
 * The in-repo adapter of ADR 0005: the engine renders this app inside its own
 * process. The output keeps the static shape the engine already serves
 * (`dist/` with an `index.html` SPA fallback), and adds `dist/_server/`, a
 * self-contained module whose `entry.js` exports a SvelteKit server instance.
 * The engine never serves `/_server/` as a static path.
 *
 * @returns {import('@sveltejs/kit').Adapter}
 */
export default function adapter() {
  return {
    name: 'zveltio-engine',
    async adapt(builder) {
      const out = 'dist';
      const server = join(out, '_server');
      builder.rimraf(out);
      builder.writeClient(out);
      builder.writePrerendered(out);
      // Served when the render is switched off or throws.
      await builder.generateFallback(join(out, 'index.html'));
      builder.writeServer(server);
      builder.generateServerInstance(join(server, 'entry.js'), { serverDirectory: server });
    },
  };
}
