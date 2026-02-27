import DocumentsPage from './pages/DocumentsPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'ro-documents',
    component: DocumentsPage,
    label: 'Documente RO',
    icon: 'FolderOpen',
    category: 'compliance',
  });
}
