// The Worker entry the test pool loads. The real entry (src/index.ts) imports the whole app, and the pool
// evaluates its entry before any test file runs, which would load every module before a test's vi.mock
// could replace it. Tests that need the real entry import src/index.ts themselves.
export default {
  fetch: (): Response => new Response('worker stub'),
} satisfies ExportedHandler;
