import { expect, vi, describe, it } from 'vitest';
import { addEventListener } from './addEventListener';

describe('addEventListener', () => {
  it('adds the listener and returns an unsubscribe function', () => {
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const listener = vi.fn();
    const options = { capture: true, passive: false };

    const unsubscribe = addEventListener(target, 'click', listener, options);

    expect(target.addEventListener).toHaveBeenCalledWith('click', listener, options);

    unsubscribe();

    expect(target.removeEventListener).toHaveBeenCalledWith('click', listener, options);
  });

  it('leverages AbortSignal.timeout when timeout option is provided', () => {
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const listener = vi.fn();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    try {
      const unsubscribe = addEventListener(target, 'click', listener, { timeout: 1000 });

      expect(timeoutSpy).toHaveBeenCalledWith(1000);
      expect(target.addEventListener).toHaveBeenCalledWith(
        'click',
        listener,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      unsubscribe();
      expect(target.removeEventListener).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
