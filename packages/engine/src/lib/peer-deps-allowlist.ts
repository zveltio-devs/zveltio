/**
 * Allow-list of npm packages that extensions may declare in their
 * manifest.json `peerDependencies` field.
 *
 * Why an allow-list: an unrestricted peerDependencies field lets a published
 * extension pull in an arbitrary npm package at install time — a supply-chain
 * attack vector. Restricting to a known-safe set forces marketplace review
 * for new packages.
 *
 * To add a package: append below with a short comment noting which extension
 * uses it and why. Be specific — "for X" is fine, "useful library" is not.
 */

export const PEER_DEPS_ALLOWLIST: ReadonlySet<string> = new Set([
  // Auth providers
  'node-saml',         // auth/saml — SAML SSO assertions
  'ldapts',            // auth/ldap — LDAP / Active Directory client

  // Communications
  'imapflow',          // communications/mail — IMAP client
  'mailparser',        // communications/mail — parse incoming emails
  'nodemailer',        // communications/mail — SMTP send

  // S3-compatible storage (when aws4fetch is not enough)
  '@aws-sdk/client-s3',           // content/media, storage/cloud
  '@aws-sdk/s3-request-presigner', // storage/cloud — presigned URLs

  // ID + crypto utilities
  'nanoid',            // shared — short URL-safe identifier generation

  // PDF / document generation
  'qrcode',            // operations/traceability — QR codes on dispatches
  'pdfkit',            // operations/traceability — PDF generation

  // Query language
  'graphql',           // developer/graphql — GraphQL schema + execution
]);

export function isPackageAllowed(pkg: string): boolean {
  return PEER_DEPS_ALLOWLIST.has(pkg);
}
