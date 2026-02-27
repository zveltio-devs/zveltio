import FlowsPage from './pages/FlowsPage.svelte';
import FlowEditorPage from './pages/FlowEditorPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'flows',
    component: FlowsPage,
    label: 'Flows',
    icon: 'Workflow',
    category: 'automation',
    children: [
      {
        path: 'flows/:id/edit',
        component: FlowEditorPage,
        label: 'Flow Editor',
        icon: 'GitBranch',
        category: 'automation',
      },
    ],
  });
}
