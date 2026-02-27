import ProcurementPage from './pages/ProcurementPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'ro-procurement',
    component: ProcurementPage,
    label: 'Achizitii RO',
    icon: 'ShoppingCart',
    category: 'compliance',
  });
}
