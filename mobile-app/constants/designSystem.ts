/**
 * Shared tokens for tab screens (Home, Settings) — typography, color, spacing, radii.
 */
export const DS = {
  space: {
    /** 8 */
    xs: 8,
    /** 12 */
    sm: 12,
    /** 16 */
    md: 16,
    /** 20 */
    lg: 20,
    /** 24 */
    xl: 24,
    /** 40 */
    xxl: 40,
  },
  color: {
    background: "#FAFAFA",
    surface: "#FFFFFF",
    border: "#EEEEEE",
    textPrimary: "#111111",
    textSecondary: "#666666",
    textTertiary: "#8E8E93",
    textQuaternary: "#AEAEB2",
    divider: "#E5E5EA",
    accent: "#25D366",
    destructive: "#DC2626",
    icon: "rgba(17, 17, 17, 0.45)",
    iconMuted: "#C4C4C4",
    btnDark: "#4A4A4A",
    comingSoonSurface: "#F2F2F7",
  },
  radius: {
    sm: 10,
    md: 12,
  },
  /** Consistent press feedback (opacity) */
  pressOpacity: 0.82,
  pressOpacitySoft: 0.88,
} as const;
