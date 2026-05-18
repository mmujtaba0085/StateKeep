/**
 * test/crypto.spec.js
 *
 * Unit tests for AES-256-GCM context encryption (mirrors logic in src/registry/db.js).
 * No server, no DB, no native modules required.
 *
 * Run: node --test test/crypto.spec.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ── Mirror the exact algorithm from src/registry/db.js ───────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12;   // 96-bit nonce for GCM
const TAG_LEN   = 16;   // 128-bit auth tag

function makeKey() {
  return randomBytes(32);
}

function encrypt(plaintext, key) {
  if (!key) return Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body   = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const enc    = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(ciphertext, key) {
  if (!key) return ciphertext;
  if (!Buffer.isBuffer(ciphertext)) ciphertext = Buffer.from(ciphertext);
  const iv       = ciphertext.slice(0, IV_LEN);
  const tag      = ciphertext.slice(IV_LEN, IV_LEN + TAG_LEN);
  const enc      = ciphertext.slice(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ── SC-CRYPTO: AES-256-GCM round-trip ────────────────────────────────────────

describe('SC-CRYPTO: AES-256-GCM context encryption', () => {

  test('C1: empty string round-trips correctly', () => {
    const key  = makeKey();
    const enc  = encrypt(Buffer.from(''), key);
    const dec  = decrypt(enc, key);
    assert.equal(dec.toString('utf8'), '');
  });

  test('C2: JSON context round-trips correctly', () => {
    const key     = makeKey();
    const payload = JSON.stringify({ userId: 'abc', balance: 100, tags: ['a', 'b'] });
    const enc     = encrypt(Buffer.from(payload), key);
    const dec     = decrypt(enc, key);
    assert.equal(dec.toString('utf8'), payload);
  });

  test('C3: ciphertext is longer than plaintext (IV + tag overhead)', () => {
    const key  = makeKey();
    const msg  = Buffer.from('hello');
    const enc  = encrypt(msg, key);
    assert.ok(enc.length > msg.length, 'ciphertext is larger than plaintext');
    assert.equal(enc.length, IV_LEN + TAG_LEN + msg.length);
  });

  test('C4: two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
    const key  = makeKey();
    const msg  = Buffer.from('determinism-test');
    const enc1 = encrypt(msg, key);
    const enc2 = encrypt(msg, key);
    assert.notDeepEqual(enc1, enc2, 'random IV ensures different ciphertexts each time');
  });

  test('C5: ciphertext does not contain recognizable plaintext (at-rest privacy)', () => {
    const key  = makeKey();
    const secret = 'super-secret-context-value-12345';
    const enc  = encrypt(Buffer.from(secret), key);
    assert.ok(!enc.toString('utf8').includes('super-secret'), 'plaintext not visible in ciphertext');
    assert.ok(!enc.toString('latin1').includes('super-secret'), 'plaintext not visible as latin1');
  });

  test('C6: wrong auth tag (tampered ciphertext) causes decryption to throw', () => {
    const key  = makeKey();
    const enc  = encrypt(Buffer.from('tamper-me'), key);
    // Flip a byte in the auth tag region
    const tampered = Buffer.from(enc);
    tampered[IV_LEN] ^= 0xff;
    assert.throws(() => decrypt(tampered, key), /unsupported|auth|bad decrypt|Unsupported state or unable/i);
  });

  test('C7: wrong key causes decryption to throw', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const enc  = encrypt(Buffer.from('key-rotation-test'), key1);
    assert.throws(() => decrypt(enc, key2));
  });

  test('C8: no-key mode passes plaintext through unchanged (no encryption)', () => {
    const msg = Buffer.from('unencrypted-plaintext');
    const enc = encrypt(msg, null);
    assert.deepEqual(enc, msg, 'without key, encrypt returns plaintext buffer');
    const dec = decrypt(enc, null);
    assert.deepEqual(dec, msg, 'without key, decrypt returns buffer unchanged');
  });

  test('C9: large payload (1 MB context) round-trips correctly', () => {
    const key  = makeKey();
    const data = Buffer.alloc(1_048_576, 0x42);   // 1 MB of 0x42
    const enc  = encrypt(data, key);
    const dec  = decrypt(enc, key);
    assert.deepEqual(dec, data, '1 MB round-trip matches');
  });

  test('C10: string input is accepted (converted to Buffer internally)', () => {
    const key = makeKey();
    const enc = encrypt('string-input-test', key);
    const dec = decrypt(enc, key);
    assert.equal(dec.toString('utf8'), 'string-input-test');
  });
});

// ── SC-CRYPTO-ROT: key rotation semantics ────────────────────────────────────

describe('SC-CRYPTO-ROT: key rotation — old ciphertext unreadable with new key', () => {

  test('ROT-1: data encrypted with key1 cannot be decrypted with key2', () => {
    const key1 = makeKey();
    const key2 = makeKey();
    const enc  = encrypt(Buffer.from('sensitive data'), key1);
    assert.throws(() => decrypt(enc, key2), 'key2 cannot decrypt key1 ciphertext');
  });

  test('ROT-2: after rotation, newly encrypted data is readable with new key', () => {
    const key1 = makeKey();
    const key2 = makeKey();

    // Old data encrypted with key1
    const oldEnc  = encrypt(Buffer.from('old data'), key1);

    // Re-encrypt old data with key2 (migration step)
    const oldPlain = decrypt(oldEnc, key1);
    const newEnc   = encrypt(oldPlain, key2);

    // New key reads new ciphertext
    const dec = decrypt(newEnc, key2);
    assert.equal(dec.toString('utf8'), 'old data');
  });

  test('ROT-3: key rotation preserves plaintext integrity', () => {
    const key1    = makeKey();
    const key2    = makeKey();
    const payload = JSON.stringify({ complex: true, arr: [1, 2, 3] });

    const enc1  = encrypt(Buffer.from(payload), key1);
    const plain = decrypt(enc1, key1);
    const enc2  = encrypt(plain, key2);
    const final = decrypt(enc2, key2).toString('utf8');

    assert.equal(final, payload, 'key rotation preserves full JSON payload');
  });
});
