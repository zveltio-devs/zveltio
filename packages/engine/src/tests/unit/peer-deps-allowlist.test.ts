import { describe, it, expect } from 'bun:test';
import { isPackageAllowed, PEER_DEPS_ALLOWLIST } from '../../lib/peer-deps-allowlist.js';

describe('peer-deps-allowlist', () => {
  it('allows known platform packages', () => {
    // A representative sample — the full list is in peer-deps-allowlist.ts
    expect(isPackageAllowed('node-saml')).toBe(true);
    expect(isPackageAllowed('ldapts')).toBe(true);
    expect(isPackageAllowed('imapflow')).toBe(true);
    expect(isPackageAllowed('nodemailer')).toBe(true);
    expect(isPackageAllowed('@aws-sdk/client-s3')).toBe(true);
    expect(isPackageAllowed('graphql')).toBe(true);
  });

  it('rejects packages not on the list', () => {
    expect(isPackageAllowed('left-pad')).toBe(false);
    expect(isPackageAllowed('event-stream')).toBe(false);
    expect(isPackageAllowed('@evil-org/malware')).toBe(false);
    expect(isPackageAllowed('')).toBe(false);
  });

  it('is case-sensitive — typos do not bypass the check', () => {
    expect(isPackageAllowed('NodeMailer')).toBe(false);
    expect(isPackageAllowed('Node-Saml')).toBe(false);
  });

  it('exposes the underlying set for inspection', () => {
    expect(PEER_DEPS_ALLOWLIST).toBeInstanceOf(Set);
    expect(PEER_DEPS_ALLOWLIST.size).toBeGreaterThan(0);
  });
});
