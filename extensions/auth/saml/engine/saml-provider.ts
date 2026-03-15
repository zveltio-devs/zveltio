/**
 * SAML 2.0 provider wrapper (node-saml).
 * node-saml is auto-installed by the extension loader via manifest.json peerDependencies.
 */

// @ts-ignore — node-saml is installed at runtime by extension-loader before this module loads
import { SAML } from 'node-saml';

export interface SamlIdpConfig {
  entryPoint: string;
  issuer: string;
  cert: string;
  callbackUrl: string;
  privateKey?: string;
  signatureAlgorithm?: 'sha1' | 'sha256' | 'sha512';
  wantAuthnResponseSigned?: boolean;
  acceptedClockSkewMs?: number;
}

export function createSamlInstance(config: SamlIdpConfig): any {
  return new SAML({
    entryPoint: config.entryPoint,
    issuer: config.issuer,
    cert: config.cert,
    callbackUrl: config.callbackUrl,
    privateKey: config.privateKey,
    signatureAlgorithm: config.signatureAlgorithm ?? 'sha256',
    wantAuthnResponseSigned: config.wantAuthnResponseSigned ?? true,
    acceptedClockSkewMs: config.acceptedClockSkewMs ?? 5000,
    validateInResponseTo: 'never' as const,
    disableRequestedAuthnContext: true,
  });
}

export interface SamlProfile {
  nameID: string;
  nameIDFormat?: string;
  email?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  [key: string]: any;
}

export async function validateSamlResponse(
  saml: any,
  body: Record<string, string>,
): Promise<SamlProfile> {
  const { profile } = await saml.validatePostResponseAsync(body);
  if (!profile) throw new Error('SAML validation returned empty profile');

  return {
    nameID: profile.nameID,
    nameIDFormat: profile.nameIDFormat,
    email: profile.email ?? profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'],
    displayName: profile.displayName ?? profile['http://schemas.microsoft.com/identity/claims/displayname'],
    firstName: profile.givenName ?? profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'],
    lastName: profile.sn ?? profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'],
    ...profile,
  };
}
