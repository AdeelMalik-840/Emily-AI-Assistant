import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { checkBusinessProfile } from "@/lib/checkBusiness";

/**
 * App entry: route signed-in users to tabs vs `/business` (setup); others to login.
 * All navigation runs in useEffect only (never during render).
 */
export default function Index() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!user?.email) {
      console.log("👤 Index: no user → /onboarding/login");
      router.replace("/onboarding/login");
      return;
    }

    let cancelled = false;

    void (async () => {
      console.log("👤 Index: user found:", user.uid);

      const hasBusiness = await checkBusinessProfile(user.uid);
      if (cancelled) {
        return;
      }

      if (hasBusiness) {
        console.log("✅ Index: existing user → /(tabs)");
        router.replace("/(tabs)");
      } else {
        console.log("🆕 Index: new user → /business (setup)");
        router.replace(routes.business);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user?.uid, user?.email]);

  return (
    <View style={styles.boot}>
      <ActivityIndicator size="large" color="#7C3AED" />
      <Text style={styles.loadingText}>Loading…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    gap: 12,
  },
  loadingText: {
    fontSize: 15,
    color: "#64748B",
  },
});
