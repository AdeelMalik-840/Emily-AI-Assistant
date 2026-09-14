import { Redirect, router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function OnboardingConnectScreen() {
  const { user, loading } = useAuth();

  if (!loading && !user?.email) {
    return <Redirect href={routes.onboarding.login} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.box}>
        <Text style={styles.title}>Connect WhatsApp</Text>
        <Text style={styles.body}>
          Add your business WhatsApp number from the Home tab: open Emily, tap
          Connect your WhatsApp, and enter your number there.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
          onPress={() => router.replace("/(tabs)")}
          accessibilityRole="button"
          accessibilityLabel="Go to Home"
        >
          <Text style={styles.ctaText}>Go to Home</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
          onPress={() => router.push(routes.onboarding.success)}
          accessibilityRole="button"
          accessibilityLabel="Continue onboarding"
        >
          <Text style={styles.linkText}>Skip for now</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#FAFAFA" },
  box: { padding: 24, gap: 16 },
  title: {
    fontSize: 22,
    fontWeight: "600",
    color: "#000",
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: "#3A3A3C",
  },
  cta: {
    marginTop: 8,
    backgroundColor: "#3A3A3C",
    borderRadius: 12,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaPressed: { opacity: 0.88 },
  ctaText: { fontSize: 17, fontWeight: "600", color: "#FFF" },
  link: { paddingVertical: 12, alignSelf: "flex-start" },
  linkPressed: { opacity: 0.65 },
  linkText: { fontSize: 16, fontWeight: "600", color: "#3A3A3C" },
});
