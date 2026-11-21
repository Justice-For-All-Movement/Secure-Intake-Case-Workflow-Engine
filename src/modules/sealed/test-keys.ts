// Test helper: fresh sealing key pairs and a SEALING_RECIPIENTS value for them.
import { generateKeyPair } from "./sealed-crypto";

export async function testSealingKeys(count = 1) {
  const pairs = await Promise.all(Array.from({ length: count }, () => generateKeyPair()));
  const config = JSON.stringify(
    pairs.map((pair, index) => ({ keyId: pair.id, label: `Researcher ${index + 1}`, publicJwk: pair.publicJwk })),
  );
  return {
    pairs,
    config,
    recipients: pairs.map((pair) => ({ id: pair.id, publicJwk: pair.publicJwk })),
  };
}
