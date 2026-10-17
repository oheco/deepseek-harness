/** DSH semantic colors for the native search and context-menu overlays. */
export class OverlayPalette {
  surface: string;
  input: string;
  text: string;
  muted: string;
  border: string;
  hover: string;
  accent: string;
  shadow: string;

  constructor(dark: boolean = false) {
    this.surface = dark ? '#FF353638' : '#FFFFFFFF';
    this.input = dark ? '#FF2C2C2E' : '#FFFFFFFF';
    this.text = dark ? '#FFF9FAFB' : '#FF0F1115';
    this.muted = dark ? '#FFADB2B8' : '#FF81858C';
    this.border = dark ? '#1FFFFFFF' : '#1A000000';
    this.hover = dark ? '#14FFFFFF' : '#0F263148';
    this.accent = dark ? '#FF679EFE' : '#FF4176E6';
    this.shadow = dark ? '#66000000' : '#26000000';
  }
}

/** Read the page's resolved DSH tokens, including an explicit in-page theme choice. */
export function overlayPaletteScript(origin: string): string {
  return '(() => { if (location.origin !== ' + JSON.stringify(origin) + ') return "";' + `
    if (!document.body) return '';
    const style = getComputedStyle(document.body);
    function color(token) {
      const value = style.getPropertyValue(token).trim();
      const m = /^rgba?\\(\\s*([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.]+))?\\s*\\)$/.exec(value);
      if (!m) return '';
      const byte = x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
      return '#' + byte(m[4] === undefined ? 255 : Number(m[4]) * 255) + byte(+m[1]) + byte(+m[2]) + byte(+m[3]);
    }
    return JSON.stringify({
      surface: color('--dsw-specific-menu'),
      input: color('--dsw-specific-input-major'),
      text: color('--dsw-alias-label-primary'),
      muted: color('--dsw-alias-label-tertiary'),
      border: color('--dsw-alias-border-l2'),
      hover: color('--dsw-alias-interactive-bg-hover'),
      accent: color('--dsw-alias-link'),
      shadow: document.body.hasAttribute('data-ds-dark-theme') ? '#66000000' : '#26000000'
    });
  })()`;
}

/** Reject non-color data at the page/native boundary. */
export function parseOverlayPalette(raw: string): OverlayPalette | undefined {
  try {
    const decoded: string = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
    const palette = JSON.parse(decoded) as OverlayPalette;
    const colors: string[] = [palette.surface, palette.input, palette.text, palette.muted,
      palette.border, palette.hover, palette.accent, palette.shadow];
    for (const color of colors) {
      if (typeof color !== 'string' || !/^#[0-9a-fA-F]{8}$/.test(color)) {
        return undefined;
      }
    }
    return palette;
  } catch (_) {
    // An unloaded or differently branded page uses the system-theme fallback.
    return undefined;
  }
}
