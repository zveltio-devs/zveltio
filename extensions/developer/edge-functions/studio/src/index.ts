import EdgeFunctionsPage from './pages/EdgeFunctionsPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'edge-functions',
    component: EdgeFunctionsPage,
    label: 'Edge Functions',
    icon: 'Zap',
    category: 'developer',
  });
}
