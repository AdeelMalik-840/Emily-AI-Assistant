import { router } from "expo-router";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { GradientButton } from "@/components/ui/GradientButton";
import { Brand } from "@/constants/brand";
import { auth, db } from "@/firebase";

export default function OnboardingSuccessScreen() {
  const goDashboard = async () => {
    const u = auth.currentUser;
    if (u?.uid) {
      try {
        await setDoc(
          doc(db, "businesses", u.uid),
          { whatsappConnected: true, updatedAt: serverTimestamp() },
          { merge: true }
        );
      } catch (e) {
        console.warn("[onboarding/success] could not persist whatsappConnected:", e);
      }
    }
    router.replace("/(tabs)");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <View style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.emoji} accessibilityLabel="Success">
            🎉
          </Text>
          <Text style={styles.heading}>WhatsApp Connected</Text>
          <Text style={styles.subtext}>
            Emily is now active on your number
          </Text>
        </View>

        <GradientButton
          title="Go to Dashboard"
          onPress={() => {
            void goDashboard();
          }}
          accessibilityLabel="Go to dashboard"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: Brand.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: 28,
    paddingBottom: 16,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emoji: {
    fontSize: 72,
    marginBottom: 24,
  },
  heading: {
    fontSize: 28,
    fontWeight: "800",
    color: "#0F172A",
    textAlign: "center",
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  subtext: {
    fontSize: 17,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 26,
    maxWidth: 300,
  },
});
