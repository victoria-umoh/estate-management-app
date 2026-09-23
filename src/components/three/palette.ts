/**
 * Design tokens, resolved to numbers a WebGL material can use.
 *
 * Materials cannot read CSS custom properties, and the palette is authored in
 * OKLCH, which `THREE.Color` cannot parse. Rather than duplicating hex values
 * here — which would silently drift from `globals.css` and break in dark mode —
 * the browser does the conversion: a 1x1 canvas accepts any colour string it
 * understands and hands back sRGB bytes.
 */
export interface Palette {
  background: string;
  primary: string;
  accent: string;
  success: string;
  warning: string;
  muted: string;
  border: string;
  foreground: string;
}

/** Used only if the browser rejects every token, which would mean a black scene. */
const LAST_RESORT = '#808080';

function toHex(value: string, probe: CanvasRenderingContext2D): string {
  // fillStyle silently ignores a value it cannot parse, so seed it with a
  // sentinel and treat "unchanged" as failure rather than trusting the read.
  probe.fillStyle = '#000000';
  probe.fillStyle = value;
  if (probe.fillStyle === '#000000' && value.trim() !== '#000000') {
    // Could genuinely be black, but for this palette it means the parse failed.
    return LAST_RESORT;
  }

  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

export function readPalette(): Palette {
  const probe =
    typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d', { willReadFrequently: true });

  const styles = probe === null ? null : getComputedStyle(document.documentElement);

  const read = (token: string): string =>
    probe === null || styles === null
      ? LAST_RESORT
      : toHex(styles.getPropertyValue(`--${token}`), probe);

  // Listed one by one rather than mapped, so adding a field to `Palette`
  // without reading a token for it is a compile error.
  return {
    background: read('background'),
    primary: read('primary'),
    accent: read('accent'),
    success: read('success'),
    warning: read('warning'),
    muted: read('muted'),
    border: read('border'),
    foreground: read('foreground'),
  };
}
