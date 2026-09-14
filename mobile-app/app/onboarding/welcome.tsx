import { router } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { GradientButton } from "@/components/ui/GradientButton";
import { Brand } from "@/constants/brand";
import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { checkBusinessProfile } from "@/lib/checkBusiness";

export default function OnboardingWelcomeScreen() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user?.email) return;

    let cancelled = false;
    void (async () => {
      console.log("[welcome] Signed-in user, checking business profile…");
      const hasBusiness = await checkBusinessProfile(user.uid);
      if (cancelled) return;
      if (hasBusiness) {
        console.log("✅ Welcome routing → existing user /(tabs)");
        router.replace("/(tabs)");
      } else {
        console.log("🆕 Welcome routing → /business (setup)");
        router.replace(routes.business);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user?.uid, user?.email]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (user?.email) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <View style={styles.container}>
        <View style={styles.upper}>
          <View style={styles.heroGlow} />
          <View style={styles.illustration}>
            <Text style={styles.illustrationEmoji} accessibilityLabel="Assistant illustration">
              💬
            </Text>
            <Text style={styles.illustrationHint}>AI assistant</Text>
          </View>

          <View style={styles.copyBlock}>
            <Text style={styles.appName}>Emily</Text>
            <Text style={styles.heading}>Your smartest support agent, built for WhatsApp</Text>
            <Text style={styles.subtext}>
              Reply faster with AI that matches your business — multilingual, on-brand, 24/7.
            </Text>
          </View>
        </View>

        <View style={styles.footer}>
          <GradientButton
            title="Get Started"
            onPress={() => {
              console.log("📍 Welcome → login");
              router.push(routes.onboarding.login);
            }}
            accessibilityLabel="Get started"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Brand.background,
  },
  safe: {
    flex: 1,
    backgroundColor: Brand.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: 28,
  },
  upper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  heroGlow: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: Brand.glowPurple,
    top: "12%",
    opacity: 0.9,
  },
  illustration: {
    width: "100%",
    maxWidth: 300,
    aspectRatio: 1.1,
    maxHeight: 200,
    borderRadius: 28,
    backgroundColor: Brand.backgroundSoft,
    borderWidth: 1,
    borderColor: Brand.cardBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 36,
    zIndex: 1,
  },
  illustrationEmoji: {
    fontSize: 56,
    marginBottom: 8,
  },
  illustrationHint: {
    fontSize: 13,
    fontWeight: "600",
    color: Brand.textMuted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  copyBlock: {
    alignItems: "center",
    maxWidth: 340,
    zIndex: 1,
  },
  appName: {
    fontSize: 36,
    fontWeight: "800",
    color: Brand.text,
    letterSpacing: -1,
    marginBottom: 14,
    textAlign: "center",
  },
  heading: {
    fontSize: 24,
    fontWeight: "700",
    color: Brand.text,
    lineHeight: 32,
    textAlign: "center",
    marginBottom: 14,
    letterSpacing: -0.4,
  },
  subtext: {
    fontSize: 16,
    fontWeight: "400",
    color: Brand.textSecondary,
    lineHeight: 24,
    textAlign: "center",
  },
  footer: {
    paddingBottom: 8,
    paddingTop: 16,
  },
});
