import ChecklistsPage from './pages/ChecklistsPage.svelte';
import TemplatesPage from './pages/TemplatesPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) {
    console.error('Zveltio Studio API not available');
    return;
  }

  zveltio.registerRoute({
    path: 'checklists',
    component: ChecklistsPage,
    label: 'Checklists',
    icon: 'CheckSquare',
    category: 'workflow',
    children: [
      {
        path: 'checklists/templates',
        component: TemplatesPage,
        label: 'Templates',
        icon: 'LayoutTemplate',
        category: 'workflow',
      },
    ],
  });
}
