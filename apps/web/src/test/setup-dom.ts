// Only register DOM-related setup when a document exists (jsdom env).
// Tests with `environment: 'node'` skip this file's effects entirely.
export {};

if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
