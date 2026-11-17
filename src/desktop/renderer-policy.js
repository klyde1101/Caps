// Chromium only enforces frame-ancestors when delivered as a response header.
export function protectRendererFromFraming(session, rendererUrl) {
  session.webRequest.onHeadersReceived({ urls: [rendererUrl] }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["frame-ancestors 'none'"]
      }
    });
  });
}
