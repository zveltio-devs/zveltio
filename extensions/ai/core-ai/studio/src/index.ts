import AISettingsPage from './pages/AISettingsPage.svelte';
import AIPlaygroundPage from './pages/AIPlaygroundPage.svelte';

export default function register() {
  const zveltio = (window as any).__zveltio;
  if (!zveltio) return;

  zveltio.registerRoute({
    path: 'ai',
    component: AISettingsPage,
    label: 'AI Settings',
    icon: 'Sparkles',
    category: 'ai',
    children: [
      {
        path: 'ai/playground',
        component: AIPlaygroundPage,
        label: 'Playground',
        icon: 'MessageSquare',
        category: 'ai',
      },
    ],
  });
}
