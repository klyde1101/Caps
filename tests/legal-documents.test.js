import test from 'node:test';
import assert from 'node:assert/strict';
import { readLegalDocument } from '../src/desktop/legal-documents.js';

test('all legal documents are readable offline and document access cannot traverse the filesystem', async () => {
  for (const id of ['privacy', 'terms', 'eula', 'disclaimer', 'license', 'notices']) {
    assert.ok((await readLegalDocument(id)).length > 100, id);
  }
  for (const value of ['../../package.json', '__proto__', 'constructor', null, {}]) await assert.rejects(readLegalDocument(value));
  assert.match(await readLegalDocument('license'), /Permission is hereby granted/);
  assert.match(await readLegalDocument('eula'), /does not require separate acceptance, ban redistribution/);
  for (const id of ['privacy', 'terms', 'eula']) {
    const text = await readLegalDocument(id);
    assert.ok(text.includes('klyde.penus1101@gmail.com'));
    assert.doesNotMatch(text, /No dedicated private contact address/);
  }
});
