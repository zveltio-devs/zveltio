import ETransportPage from './pages/ETransportPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'etransport',
    component: ETransportPage,
    label: 'e-Transport RO',
    icon: 'Truck',
    category: 'compliance',
  });
}
