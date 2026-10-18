import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCreateWebGL2 } from '../src/city/webgl';

afterEach(() => vi.unstubAllGlobals());

describe('WebGL2 startup probe', () => {
  function canvas(getContext: ReturnType<typeof vi.fn>) {
    const element = { width: 300, height: 150, getContext };
    const createElement = vi.fn(() => element);
    vi.stubGlobal('document', { createElement });
    return { element, createElement };
  }

  it('releases a successful probe immediately and requests the renderer quality', () => {
    const loseContext = vi.fn();
    const getExtension = vi.fn(() => ({ loseContext }));
    const getContext = vi.fn(() => ({ getExtension }));
    const { element, createElement } = canvas(getContext);
    expect(canCreateWebGL2(false)).toBe(true);
    expect(createElement).toHaveBeenCalledExactlyOnceWith('canvas');
    expect([element.width, element.height]).toEqual([1, 1]);
    expect(getContext).toHaveBeenCalledExactlyOnceWith('webgl2', { antialias: true, powerPreference: 'low-power' });
    expect(getExtension).toHaveBeenCalledExactlyOnceWith('WEBGL_lose_context');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('falls back when WebGL2 is absent, even if WebGL1 could work', () => {
    const getContext = vi.fn((type: string) => type === 'webgl' ? {} : null);
    canvas(getContext);
    expect(canCreateWebGL2(true)).toBe(false);
    expect(getContext).toHaveBeenCalledExactlyOnceWith('webgl2', { antialias: false, powerPreference: 'low-power' });
  });

  it('falls back when a disabled graphics API throws', () => {
    canvas(vi.fn(() => { throw new Error('Graphics are disabled'); }));
    expect(canCreateWebGL2(false)).toBe(false);
  });

  it('does not require an optional context-loss extension', () => {
    canvas(vi.fn(() => ({ getExtension: () => null })));
    expect(canCreateWebGL2(false)).toBe(true);
  });

  it.each(['getExtension', 'loseContext'])('keeps the capability result if %s cleanup throws', (failure) => {
    canvas(vi.fn(() => ({ getExtension: () => {
      if (failure === 'getExtension') throw new Error('Driver cleanup failed');
      return { loseContext: () => { throw new Error('Driver cleanup failed'); } };
    } })));
    expect(canCreateWebGL2(false)).toBe(true);
  });
});
