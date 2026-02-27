import GeospatialPage from './pages/GeospatialPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'geo',
    component: GeospatialPage,
    label: 'Geospatial',
    icon: 'MapPin',
    category: 'geospatial',
  });
}
