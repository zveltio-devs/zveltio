import ApprovalsPage from './pages/ApprovalsPage.svelte';
import WorkflowsPage from './pages/WorkflowsPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) {
    console.error('[approvals] Zveltio Studio API not available');
    return;
  }

  zveltio.registerRoute({
    path: 'approvals',
    component: ApprovalsPage,
    label: 'Approvals',
    icon: 'GitBranch',
    category: 'workflow',
    children: [
      {
        path: 'approvals/workflows',
        component: WorkflowsPage,
        label: 'Workflows',
        icon: 'Workflow',
        category: 'workflow',
      },
    ],
  });
}
