/**
 * Brand palette inspired by modern AI / support-agent marketing UI:
 * white surfaces, purple → pink → orange gradients, high-contrast type.
 */
export const Brand = {
  background: "#FFFFFF",
  backgroundSoft: "#FAFAFC",
  text: "#0F172A",
  textSecondary: "#64748B",
  textMuted: "#94A3B8",
  /** Primary gradient (left/top → right/bottom) */
  gradientColors: ["#7C3AED", "#DB2777", "#F97316"] as const,
  /** Soft glow behind hero cards */
  glowPurple: "rgba(124, 58, 237, 0.12)",
  glowPink: "rgba(219, 39, 119, 0.08)",
  tint: "#7C3AED",
  cardBorder: "#EEF2FF",
  shadow: "rgba(124, 58, 237, 0.25)",
} as const;
