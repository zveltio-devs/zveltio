/**
 * LDAP provider wrapper (ldapts — TypeScript-native, no native binaries).
 * ldapts is auto-installed by the extension loader via manifest.json peerDependencies.
 */

// @ts-ignore — ldapts is installed at runtime by extension-loader before this module loads
import { Client } from 'ldapts';

export interface LdapConfig {
  url: string;
  bindDN: string;
  bindPassword: string;
  searchBase: string;
  searchFilter: string;
  usernameAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  tlsVerify: boolean;
}

export interface LdapUser {
  dn: string;
  email: string;
  displayName: string;
  username: string;
  [key: string]: any;
}

/** Authenticate a user against LDAP. Returns the user profile or throws. */
export async function ldapAuthenticate(
  config: LdapConfig,
  username: string,
  password: string,
): Promise<LdapUser> {
  if (!username || !password) throw new Error('Username and password are required');

  const filter = config.searchFilter.replace(/\{\{username\}\}/g, escapeLdap(username));

  const client = new Client({
    url: config.url,
    tlsOptions: config.tlsVerify ? {} : { rejectUnauthorized: false },
    timeout: 10000,
    connectTimeout: 10000,
  });

  try {
    await client.bind(config.bindDN, config.bindPassword);

    const { searchEntries } = await client.search(config.searchBase, {
      scope: 'sub',
      filter,
      attributes: [config.emailAttribute, config.nameAttribute, config.usernameAttribute, 'dn'],
    });

    if (searchEntries.length === 0) throw new Error('User not found in directory');
    const entry = searchEntries[0];

    await client.unbind();
    await client.bind(entry.dn, password);

    return {
      dn: entry.dn,
      email: String(entry[config.emailAttribute] ?? entry.mail ?? ''),
      displayName: String(entry[config.nameAttribute] ?? entry.cn ?? username),
      username: String(entry[config.usernameAttribute] ?? username),
    };
  } finally {
    try { await client.unbind(); } catch { /* ignore */ }
  }
}

/** Escape special LDAP filter characters (RFC 4515) */
function escapeLdap(input: string): string {
  return input.replace(/[\\*()\x00]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
