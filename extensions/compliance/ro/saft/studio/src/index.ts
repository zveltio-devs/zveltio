import SAFTPage from './pages/SAFTPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'saft',
    component: SAFTPage,
    label: 'SAF-T RO',
    icon: 'FileSpreadsheet',
    category: 'compliance',
  });
}
