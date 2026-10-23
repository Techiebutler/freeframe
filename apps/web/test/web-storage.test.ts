import { describe, it, expect } from 'vitest';

// From Node 25, Node ships its own experimental Web Storage global, on by
// default. In a vitest worker it shadows jsdom's, and without
// --localstorage-file it is `undefined`, so every store that touches
// localStorage fails to load with "Cannot read properties of undefined
// (reading 'getItem')" (#352). vitest.config.ts turns Node's off in workers.
describe('jsdom Web Storage (#352)', () => {
  it.each(['localStorage', 'sessionStorage'] as const)(
    "%s is jsdom's Storage, not Node's built-in",
    (name) => {
      const storage = window[name];
      expect(storage).toBeInstanceOf(window.Storage);
      expect(globalThis[name]).toBe(storage);

      storage.setItem('ff-web-storage-probe', '1');
      expect(storage.getItem('ff-web-storage-probe')).toBe('1');
      storage.removeItem('ff-web-storage-probe');
      expect(storage.getItem('ff-web-storage-probe')).toBeNull();
    },
  );
});
