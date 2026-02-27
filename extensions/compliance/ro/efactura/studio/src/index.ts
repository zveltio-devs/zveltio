import EfacturaPage from './pages/EfacturaPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'efactura',
    component: EfacturaPage,
    label: 'e-Factura RO',
    icon: 'Receipt',
    category: 'compliance',
  });
}
