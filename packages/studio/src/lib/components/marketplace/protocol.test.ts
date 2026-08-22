import { describe, expect, it } from 'vitest';
import {
  MARKETPLACE_FRAME_MESSAGE_TYPES,
  MARKETPLACE_SANDBOX_PROTOCOL,
} from './protocol.js';

describe('marketplace sandbox protocol', () => {
  it('pins v1 message types', () => {
    expect(MARKETPLACE_SANDBOX_PROTOCOL).toBe(1);
    expect([...MARKETPLACE_FRAME_MESSAGE_TYPES]).toEqual([
      'zveltio:marketplace:ready',
      'zveltio:marketplace:navigate',
      'zveltio:marketplace:toast',
    ]);
  });
});
