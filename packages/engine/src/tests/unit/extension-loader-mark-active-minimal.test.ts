/**
 * ExtensionLoader.markActive — creates a minimal loaded entry when absent.
 */

import { describe, expect, it } from 'bun:test';
import { ExtensionLoader } from '../../lib/extensions/extension-loader.js';

describe('ExtensionLoader.markActive', () => {
  it('inserts a placeholder loaded entry with registeredRoutes=true', () => {
    const loader = new ExtensionLoader();
    expect(loader.isActive('manual-ext')).toBe(false);
    loader.markActive('manual-ext');
    expect(loader.isActive('manual-ext')).toBe(true);
    expect(loader.getActive()).toContain('manual-ext');
    const entry = loader.loaded.get('manual-ext');
    expect(entry?.registeredRoutes).toBe(true);
  });

  it('does not overwrite an existing loaded entry', () => {
    const loader = new ExtensionLoader();
    loader.loaded.set('existing', {
      name: 'existing',
      registeredRoutes: false,
      allowedTables: new Set(['zvd_items']),
    } as never);
    loader.markActive('existing');
    expect(loader.loaded.get('existing')?.registeredRoutes).toBe(false);
    expect(loader.loaded.get('existing')?.allowedTables?.has('zvd_items')).toBe(true);
  });
});
