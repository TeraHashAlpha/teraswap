import { darkTheme } from '@rainbow-me/rainbowkit'
import { v2BodyFontFamily } from '../font-loader'
import { V2_COLORS } from '../tokens'

/**
 * [ADR-025] RainbowKit connect-modal theme (pack 04): accent cream, background surface, radius 18, IBM Plex Sans (Round 7 D1), dark only.
 * Applied by a nested RainbowKitProvider inside the shell, so v1's root provider (gold accent, light/dark by user
 * preference) is untouched. The wallet list itself is `wagmiConfig`'s — nothing is re-declared here.
 */
export function createV2RainbowTheme() {
  const base = darkTheme({
    accentColor: V2_COLORS.cream,
    accentColorForeground: V2_COLORS.bg,
    borderRadius: 'large',
    overlayBlur: 'small',
  })
  return {
    ...base,
    colors: {
      ...base.colors,
      modalBackground: V2_COLORS.surface,
      modalBorder: V2_COLORS.border,
      modalText: V2_COLORS.text,
      modalTextSecondary: V2_COLORS.muted,
      modalTextDim: V2_COLORS.dim,
      generalBorder: V2_COLORS.border,
      menuItemBackground: V2_COLORS.surface2,
    },
    radii: { ...base.radii, modal: '18px' },
    fonts: { body: v2BodyFontFamily },
  }
}
