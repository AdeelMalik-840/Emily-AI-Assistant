/**
 * Typed route paths for onboarding + main app (Expo Router / React Navigation).
 */
export const routes = {
  onboarding: {
    welcome: "/onboarding/welcome",
    login: "/onboarding/login",
    phone: "/onboarding/phone",
    otp: "/onboarding/otp",
    /** @deprecated Use `routes.business` — unified `/business` screen */
    business: "/business",
    connect: "/onboarding/connect",
    success: "/onboarding/success",
  },
  /** Main tab shell (opens first tab = Home) */
  tabs: "/(tabs)",
  home: "/(tabs)",
  /** Business profile (stack screen, opened from Settings) */
  business: "/business",
} as const;
