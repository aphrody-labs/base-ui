import { expect, describe, it, vi } from 'vitest';
import { generateId } from './generateId';

describe('generateId', () => {
  it('generates unique ids using crypto.randomUUID when available', () => {
    const id1 = generateId('prefix');
    const id2 = generateId('prefix');

    expect(id1.startsWith('prefix-')).toBe(true);
    expect(id2.startsWith('prefix-')).toBe(true);
    expect(id1).not.toBe(id2);
  });

  it('falls back to Math.random counter when crypto.randomUUID is unavailable', () => {
    const originalRandomUUID = globalThis.crypto?.randomUUID;
    try {
      // @ts-expect-error test fallback
      delete globalThis.crypto.randomUUID;

      const id1 = generateId('fallback');
      const id2 = generateId('fallback');

      expect(id1.startsWith('fallback-')).toBe(true);
      expect(id2.startsWith('fallback-')).toBe(true);
      expect(id1).not.toBe(id2);
    } finally {
      if (originalRandomUUID) {
        globalThis.crypto.randomUUID = originalRandomUUID;
      }
    }
  });
});
