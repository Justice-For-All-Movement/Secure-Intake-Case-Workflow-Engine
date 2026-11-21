// Sealed records: encryption in the researcher's browser, so the server only ever holds ciphertext.
// Uses only Web Crypto (browser and Node). Scheme, version 1:
//  - each researcher has an ECDH P-256 key pair; the private key stays on their devices (IndexedDB, and a backup file
//    encrypted with a passphrase: PBKDF2-SHA-256, 600,000 iterations, AES-256-GCM);
//  - a record is encrypted with a fresh AES-256-GCM content key; the content key is wrapped for each recipient with an
//    ephemeral ECDH P-256 key, HKDF-SHA-256 (info "pam-sealed-v1") and AES-256-GCM;
//  - commitment: SHA-256 over a random 32-byte salt and the canonical plaintext. The salt is inside the ciphertext, so
//    the commitment reveals nothing (short messages cannot be guessed from it), yet anyone who can decrypt can show the
//    original is unchanged.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (bytes) => { let s = ''; const u = new Uint8Array(bytes); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

/** Canonical JSON (sorted keys), so the same content always hashes the same way. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** Key id: SHA-256 of the canonical public JWK (crv, kty, x, y), shown to people as a fingerprint. */
export async function keyId(publicJwk) {
  const { crv, kty, x, y } = publicJwk;
  return hex(await subtle.digest('SHA-256', enc.encode(canonical({ crv, kty, x, y }))));
}
export function fingerprintText(id) { return id.slice(0, 32).match(/.{4}/g).join(' '); }

export async function generateKeyPair() {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const publicJwk = await subtle.exportKey('jwk', kp.publicKey); const privateJwk = await subtle.exportKey('jwk', kp.privateKey);
  return { publicJwk: { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }, privateJwk, id: await keyId(publicJwk) };
}
export async function importPrivate(privateJwk, extractable = false) { return subtle.importKey('jwk', privateJwk, ECDH, extractable, ['deriveBits']); }

async function wrapKeyFor(bits, salt) {
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('pam-sealed-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts content ({ text, files?: [{ name, type, base64 }], … }) for the given recipients ([{ id, publicJwk }]). */
export async function seal(content, recipients, keepSalt = null) {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('No recipient keys: nobody could read this record');
  const salt = keepSalt ?? rand(32);
  const body = enc.encode(canonical(content));
  const commitment = hex(await subtle.digest('SHA-256', new Uint8Array([...salt, ...body])));
  const plain = enc.encode(canonical({ v: 1, salt: b64(salt), content }));
  const cek = rand(32); const iv = rand(12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain);
  const wrapped = [];
  for (const r of recipients) {
    if (await keyId(r.publicJwk) !== r.id) throw new Error(`Recipient key ${r.id.slice(0, 12)}… does not match its fingerprint`);
    const pub = await subtle.importKey('jwk', { ...r.publicJwk, ext: true }, ECDH, false, []);
    const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
    const hsalt = rand(16); const k = await wrapKeyFor(bits, hsalt); const wiv = rand(12);
    const epk = await subtle.exportKey('jwk', eph.publicKey);
    wrapped.push({ keyId: r.id, epk: { crv: epk.crv, kty: epk.kty, x: epk.x, y: epk.y }, salt: b64(hsalt), iv: b64(wiv), wrappedKey: b64(await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, k, cek)) });
  }
  return { format: 'pam-sealed', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', iv: b64(iv), ciphertext: b64(ciphertext), recipients: wrapped, commitment };
}

/** Decrypts an envelope with one private key (CryptoKey) whose id is `id`; checks the commitment. */
export async function open(envelope, id, privateKey) {
  const r = envelope.recipients.find((x) => x.keyId === id);
  if (!r) throw new Error('This record was not sealed for your key');
  const eph = await subtle.importKey('jwk', { ...r.epk, ext: true }, ECDH, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
  const k = await wrapKeyFor(bits, unb64(r.salt));
  const cek = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.iv) }, k, unb64(r.wrappedKey));
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const inner = JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, aes, unb64(envelope.ciphertext))));
  const check = hex(await subtle.digest('SHA-256', new Uint8Array([...unb64(inner.salt), ...enc.encode(canonical(inner.content))])));
  return { content: inner.content, commitmentVerified: check === envelope.commitment, salt: unb64(inner.salt) };
}

/** Re-seals a record for a new set of recipients (for example a researcher who joined later). The content and salt are
 *  kept, so the commitment — the record's fingerprint — is unchanged and the record stays the same evidence. */
export async function reseal(envelope, id, privateKey, recipients) {
  const { content, commitmentVerified, salt } = await open(envelope, id, privateKey);
  if (!commitmentVerified) throw new Error('The record does not match its fingerprint; it is not re-sealed');
  const out = await seal(content, recipients, salt);
  if (out.commitment !== envelope.commitment) throw new Error('Re-sealing changed the fingerprint');
  return out;
}

/** Passphrase-protected backup of a private key (a file the person keeps). */
export async function backup(privateJwk, publicJwk, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters');
  const salt = rand(16), iv = rand(12), iterations = 600000;
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const k = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  return { format: 'pam-sealing-key-backup', v: 1, keyId: await keyId(publicJwk), publicJwk, kdf: { name: 'PBKDF2-SHA-256', iterations, salt: b64(salt) }, iv: b64(iv),
    ciphertext: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(privateJwk)))) };
}
export async function restore(file, passphrase) {
  if (file?.format !== 'pam-sealing-key-backup') throw new Error('This is not a PAM sealing-key backup file');
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const k = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(file.kdf.salt), iterations: file.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let privateJwk;
  try { privateJwk = JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, k, unb64(file.ciphertext)))); }
  catch { throw new Error('Wrong passphrase, or the backup file is damaged'); }
  return { privateJwk, publicJwk: file.publicJwk, id: file.keyId };
}
export { b64, unb64 };
