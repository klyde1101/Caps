import test from 'node:test';
import assert from 'node:assert/strict';
import { protectRendererFromFraming } from '../src/desktop/renderer-policy.js';

test('framing policy uses a response header scoped to the renderer and preserves other headers', () => {
  let filter, handler;
  const session = { webRequest: { onHeadersReceived(value, listener) { filter = value; handler = listener; } } };
  const url = 'file:///C:/Caps/resources/app.asar/src/desktop/renderer/index.html';
  protectRendererFromFraming(session, url);
  assert.deepEqual(filter, { urls: [url] });
  const headers = { 'Content-Type': ['text/html'] };
  let response;
  handler({ responseHeaders: headers }, (value) => { response = value; });
  assert.deepEqual(response.responseHeaders, {
    'Content-Type': ['text/html'], 'Content-Security-Policy': ["frame-ancestors 'none'"]
  });
  assert.deepEqual(headers, { 'Content-Type': ['text/html'] });
});
