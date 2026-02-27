import PagesListPage from './pages/PagesListPage.svelte';
import PageEditorPage from './pages/PageEditorPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'pages',
    component: PagesListPage,
    label: 'Pages',
    icon: 'FileText',
    category: 'content',
    children: [
      {
        path: 'pages/:id/edit',
        component: PageEditorPage,
        label: 'Page Editor',
        icon: 'Edit',
        category: 'content',
      },
    ],
  });
}
