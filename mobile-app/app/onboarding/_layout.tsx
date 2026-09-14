import { Stack } from "expo-router";

/**
 * Onboarding: Welcome → Login (email magic link) → `/business` (setup). Legacy `onboarding/business` screen kept on disk only.
 * Legacy routes phone + otp redirect to login.
 */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
        contentStyle: { backgroundColor: "#FFFFFF" },
      }}
    />
  );
}
