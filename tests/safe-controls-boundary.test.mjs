import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexHtml = readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const safeModule = readFileSync(path.join(repoRoot, 'safe-controls-refinement.mjs'), 'utf8');

test('control contract keeps touch gestures and core render loop intact', () => {
    assert.match(indexHtml, /controls\.touches\.ONE\s*=\s*TOUCH\.PAN;/);
    assert.match(indexHtml, /controls\.touches\.TWO\s*=\s*TOUCH\.DOLLY_ROTATE;/);
    assert.match(indexHtml, /renderer\.render\(scene,\s*camera\);/);
    assert.doesNotMatch(indexHtml, /listenToKeyEvents\s*\(/);
});

test('safe controls module does not reference splat internals', () => {
    assert.doesNotMatch(safeModule, /holeSplat/);
    assert.doesNotMatch(safeModule, /holeSplats/);
    assert.doesNotMatch(safeModule, /createHoleSplat/);
    assert.doesNotMatch(safeModule, /applyHoleSplatTransform/);
});
