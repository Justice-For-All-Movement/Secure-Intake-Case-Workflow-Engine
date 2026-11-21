// Types for sealed-crypto.js, a byte-identical copy of the downstream research
// application's sealing library (see sealed-crypto.test.ts, which pins it).
export interface SealingPublicJwk {
  crv: string;
  kty: string;
  x: string;
  y: string;
}

export interface SealedEnvelope {
  format: "pam-sealed";
  v: 1;
  alg: "ECDH-P256+HKDF-SHA256+A256GCM";
  iv: string;
  ciphertext: string;
  recipients: Array<{
    keyId: string;
    epk: SealingPublicJwk;
    salt: string;
    iv: string;
    wrappedKey: string;
  }>;
  commitment: string;
}

export function canonical(value: unknown): string;
export function keyId(publicJwk: SealingPublicJwk): Promise<string>;
export function fingerprintText(id: string): string;
export function generateKeyPair(): Promise<{
  publicJwk: SealingPublicJwk;
  privateJwk: JsonWebKey;
  id: string;
}>;
export function importPrivate(
  privateJwk: JsonWebKey,
  extractable?: boolean,
): Promise<CryptoKey>;
export function seal(
  content: unknown,
  recipients: ReadonlyArray<{ id: string; publicJwk: SealingPublicJwk }>,
  keepSalt?: Uint8Array | null,
): Promise<SealedEnvelope>;
export function open(
  envelope: SealedEnvelope,
  id: string,
  privateKey: CryptoKey,
): Promise<{ content: unknown; commitmentVerified: boolean; salt: Uint8Array }>;
export function b64(bytes: ArrayBuffer | Uint8Array): string;
export function unb64(value: string): Uint8Array;
