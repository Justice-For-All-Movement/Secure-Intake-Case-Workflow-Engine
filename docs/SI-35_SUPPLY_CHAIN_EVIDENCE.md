# SI-35 supply-chain evidence and unfinished gates

The Docker context excludes source-control metadata, locally held environment files, runtime document storage, caches, build outputs, private-key formats and database backups. A deterministic Vitest assertion checks these patterns.

The full npm v3 dependency lock is stored as base64-encoded gzip text in `package-lock.json.gz.b64` because the fenced repository gateway accepts UTF-8 source files smaller than 200 KB; the raw lock is 311 KB. `scripts/restore-lockfile.mjs` checks the archive and restored lock SHA-256 values. Docker runs `npm ci` against the restored lock. The current CI and release workflows still run `npm install`; their protected workflow changes remain unfinished and must not be inferred from the Docker implementation. The archive was generated with `gzip -n` from npm 11.9.0 lock resolution on 2026-10-18. Regenerate only from trusted registry metadata; never edit package integrity hashes manually.

The release workflow enables BuildKit provenance and SBOM output and records the image digest and source SHA. This source change does not prove a published image's attestations or a reproducible rebuild. SI-35 still requires exact-head CI, review of dependency and license results, builder image digest pinning, and verification of actual release artifact provenance/SBOM before acceptance. No production release is authorized by this change.

## Lock restoration regression checks

Run `node --test scripts/test-dependency-lock.mjs`. Five isolated subprocess tests verify the exact restored digest and repeatability, reject invalid encoding, altered/truncated archives and missing input, and preserve an existing output lock on each failure. These checks use only synthetic temporary directories and the committed dependency archive; they do not access credentials or the network. The ordinary Vitest suite invokes this regression script. Passing them does not establish reproducible images or release attestation verification.
