import { Redirect } from "expo-router";

import { routes } from "@/constants/navigation";

/** @deprecated Use /onboarding/login (email magic link). */
export default function OnboardingOtpRedirectScreen() {
  return <Redirect href={routes.onboarding.login} />;
}
