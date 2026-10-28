/**
 * The kit's dropdown and tabs (ADR 0007, bits-ui behaviour under daisyUI). What
 * is asserted is what a mouse-only check never sees: roles, the keyboard path,
 * and that a disabled action cannot be chosen.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import KitHarness from './KitHarness.test.svelte';

afterEach(cleanup);

it('dropdown opens a menu and runs the chosen action, never a disabled one', async () => {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(KitHarness, { props: { onEdit, onDelete } });

  const trigger = screen.getByRole('button', { name: 'Actions' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await fireEvent.keyDown(trigger, { key: 'Enter' });
  const menu = await waitFor(() => screen.getByRole('menu'));
  expect(menu).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(onDelete).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
  expect(onEdit).toHaveBeenCalledTimes(1);
});

it('tabs mark the active tab and render only its panel', async () => {
  render(KitHarness, { props: { onEdit: vi.fn(), onDelete: vi.fn() } });

  expect(screen.getByRole('tablist', { name: 'Settings' })).toBeInTheDocument();
  const general = screen.getByRole('tab', { name: 'General' });
  const advanced = screen.getByRole('tab', { name: 'Advanced' });
  expect(general).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('panel general')).toBeInTheDocument();
  expect(screen.queryByText('panel advanced')).toBeNull();

  await fireEvent.click(advanced);
  expect(advanced).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('tab')).toHaveTextContent('advanced');
  expect(screen.getByText('panel advanced')).toBeInTheDocument();
});
