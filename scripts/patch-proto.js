import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const protoPath = join(root, 'node_modules/@liamcottle/rustplus.js/rustplus.proto');

// Facepunch periodically drops or loosens fields that the bundled rustplus.proto
// still marks `required` (seen: AppInfo.queuedPlayers, SellOrder.itemIsBlueprint),
// which makes protobufjs throw `missing required '...'` on decode and breaks the
// whole response (server info, map markers, etc.).
//
// Relaxing every `required` to `optional` is decode-safe — a missing field simply
// becomes `undefined` — and future-proofs against further field drift. Fields we
// send in requests are always populated by rustplus.js, so encoding is unaffected.
const original = readFileSync(protoPath, 'utf8');
const matches = original.match(/\brequired\b/g) || [];
const patched = original.replace(/\brequired\b/g, 'optional');

if (matches.length === 0) {
  console.log('patch-proto: no `required` fields found (already patched).');
} else {
  writeFileSync(protoPath, patched, 'utf8');
  console.log(`patch-proto: relaxed ${matches.length} required -> optional ✓`);
}
