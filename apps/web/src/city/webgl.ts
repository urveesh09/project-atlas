/** Probe once per renderer startup, before three.js can log a context-creation error. */
export function canCreateWebGL2(lowQuality: boolean): boolean {
  let context: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    context = canvas.getContext('webgl2', { antialias: !lowQuality, powerPreference: 'low-power' });
    return context !== null;
  } catch {
    // A disabled graphics API may throw rather than return null.
    return false;
  } finally {
    try {
      // Never retain a second GPU context. The detached canvas also becomes collectible.
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Optional extension/driver cleanup must not hide the capability result.
    }
  }
}
