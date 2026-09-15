/**
 * Conformance, not self-consistency.
 *
 * An encrypt/decrypt round-trip written by one author proves the two halves
 * agree — including on a shared mistake, a wrong info string being the obvious
 * one. The only proof that a real browser can read this is the worked example
 * in RFC 8291 §5: fixed salt, fixed server keypair, fixed subscription, one
 * expected body. Everything here is that example.
 */

import { describe, expect, it } from 'bun:test';
import { encryptPayload, generateVapidKeys } from '../../lib/web-push.js';

// RFC 8291 §5.
const PLAINTEXT = 'When I grow up, I want to be a watermelon';
const UA_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
const AS_PUBLIC =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const EXPECTED =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}
function bytesToB64url(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** The RFC's server keypair, reassembled the way WebCrypto will accept it. */
async function rfcServerKeys(): Promise<CryptoKeyPair> {
  const pub = b64urlToBytes(AS_PUBLIC);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: AS_PRIVATE,
    ext: true,
  };
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    pub as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  return { privateKey, publicKey };
}

describe('RFC 8291 §5 worked example', () => {
  it('produces the body the RFC prints, byte for byte', async () => {
    const body = await encryptPayload(
      PLAINTEXT,
      UA_PUBLIC,
      AUTH_SECRET,
      b64urlToBytes(SALT),
      await rfcServerKeys(),
    );
    expect(bytesToB64url(body)).toBe(EXPECTED);
  });

  it('puts the salt, record size and server key in the header', async () => {
    const body = await encryptPayload(
      PLAINTEXT,
      UA_PUBLIC,
      AUTH_SECRET,
      b64urlToBytes(SALT),
      await rfcServerKeys(),
    );
    expect(bytesToB64url(body.slice(0, 16))).toBe(SALT);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    expect(body[20]).toBe(65); // key id length
    expect(bytesToB64url(body.slice(21, 86))).toBe(AS_PUBLIC);
  });

  it('gives a different ciphertext each time when the salt is not pinned', async () => {
    const a = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
    const b = await encryptPayload(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b));
  });

  it('refuses a p256dh that is not an uncompressed point', async () => {
    expect(encryptPayload('x', bytesToB64url(new Uint8Array(65)), AUTH_SECRET)).rejects.toThrow(
      /uncompressed/,
    );
  });

  it('mints VAPID keys in the shape the env vars expect', async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    expect(b64urlToBytes(publicKey).length).toBe(65);
    expect(b64urlToBytes(publicKey)[0]).toBe(0x04);
    expect(b64urlToBytes(privateKey).length).toBe(32);
  });
});
