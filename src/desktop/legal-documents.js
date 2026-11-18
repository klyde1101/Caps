import { readFile } from 'node:fs/promises';

const documents = Object.freeze({
  privacy: '../legal/privacy.txt', terms: '../legal/terms.txt', eula: '../legal/eula.txt',
  disclaimer: '../legal/disclaimer.txt', license: '../../LICENSE', notices: '../legal/third-party-notices.txt'
});

export async function readLegalDocument(id) {
  if (typeof id !== 'string' || !Object.hasOwn(documents, id)) throw new Error('Choose a legal document.');
  return readFile(new URL(documents[id], import.meta.url), 'utf8');
}
