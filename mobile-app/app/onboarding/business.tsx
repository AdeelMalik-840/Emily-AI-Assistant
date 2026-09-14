import * as Haptics from "expo-haptics";
import { Redirect, router } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { doc, serverTimestamp } from "firebase/firestore";

import { GradientButton } from "@/components/ui/GradientButton";
import { Brand } from "@/constants/brand";
import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { auth, db } from "@/firebase";
import { SAVE_OPERATION_TIMEOUT_MS } from "@/utils/firestoreSave";
import { setDocMergeWithRetryOrQueue } from "@/utils/firestoreOfflineQueue";

const TONE_OPTIONS = ["friendly", "formal"] as const;
type Tone = (typeof TONE_OPTIONS)[number];

function formatToneLabel(t: Tone): string {
  return t === "friendly" ? "Friendly" : "Formal";
}

export default function OnboardingBusinessScreen() {
  const { user, loading } = useAuth();
  const insets = useSafeAreaInsets();
  const toneModalActionsBottom = Math.max(20, insets.bottom);
  const userId = user?.uid;

  const [businessName, setBusinessName] = useState("");
  const [services, setServices] = useState("");
  const [pricing, setPricing] = useState("");
  const [tone, setTone] = useState<Tone>("friendly");
  const [tonePickerOpen, setTonePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);

  const canContinue =
    Boolean(userId && user?.email) &&
    businessName.trim().length > 0 &&
    services.trim().length > 0 &&
    !saving;

  const handleContinue = useCallback(async () => {
    if (saveInFlightRef.current) return;

    if (!businessName.trim()) {
      setSaveError("Enter your business name.");
      return;
    }
    if (!services.trim()) {
      setSaveError("Describe your services.");
      return;
    }

    const u = auth.currentUser;
    if (!u?.uid || !u.email) {
      setSaveError("User not authenticated. Please sign in with your email.");
      return;
    }

    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      console.log("[OnboardingBusiness] Saving business...");
      const uid = u.uid;
      const ref = doc(db, "businesses", uid);

      const plain = {
        businessName: businessName.trim(),
        services: services.trim(),
        pricing: pricing.trim() || "",
        tone,
        userId: uid,
      };

      const writeResult = await Promise.race([
        setDocMergeWithRetryOrQueue(
          db,
          ref,
          { ...plain, updatedAt: serverTimestamp() },
          plain
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Save timed out after ${SAVE_OPERATION_TIMEOUT_MS / 1000}s. Check your connection.`
                )
              ),
            SAVE_OPERATION_TIMEOUT_MS
          )
        ),
      ]);

      console.log("✅ Business profile saved → navigating to main app");
      console.log("[OnboardingBusiness] Save successful");
      setSaveSuccess(
        writeResult.status === "queued"
          ? "Saved offline, will sync automatically"
          : "Saved. Continuing…"
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      console.log("📍 router.replace /(tabs) after business save");
      router.replace("/(tabs)");
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      console.log("[OnboardingBusiness] SAVE ERROR:", err.code, err.message);
      console.error("[OnboardingBusiness] Firestore save failed:", e);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSaveError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;
    }
  }, [businessName, services, pricing, tone]);

  if (loading) {
    return (
      <View style={styles.authLoading}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (!user?.email) {
    return <Redirect href={routes.onboarding.login} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>Business setup</Text>
          <Text style={styles.lead}>
            Tell us about your business so Emily can reply in your voice.
          </Text>

          {saveError ? (
            <Text style={styles.feedbackError}>{saveError}</Text>
          ) : null}
          {saveSuccess ? (
            <Text style={styles.feedbackSuccess}>{saveSuccess}</Text>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.label}>
              Business name <Text style={styles.req}>*</Text>
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Khan Electronics"
              placeholderTextColor="#94A3B8"
              value={businessName}
              onChangeText={setBusinessName}
              autoCapitalize="words"
              editable={!saving}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>
              Services <Text style={styles.req}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="What do you offer? e.g. repairs, sales, delivery…"
              placeholderTextColor="#94A3B8"
              value={services}
              onChangeText={setServices}
              multiline
              textAlignVertical="top"
              numberOfLines={4}
              editable={!saving}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Pricing</Text>
            <TextInput
              style={[styles.input, styles.textAreaSm]}
              placeholder="Optional — e.g. starting from $50, packages…"
              placeholderTextColor="#94A3B8"
              value={pricing}
              onChangeText={setPricing}
              multiline
              textAlignVertical="top"
              editable={!saving}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Tone</Text>
            <Pressable
              style={({ pressed }) => [
                styles.select,
                pressed && styles.selectPressed,
                saving && styles.selectDisabled,
              ]}
              onPress={() => !saving && setTonePickerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Select tone"
            >
              <Text style={styles.selectText}>{formatToneLabel(tone)}</Text>
              <Text style={styles.selectChevron}>▾</Text>
            </Pressable>
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <GradientButton
            title="Continue"
            onPress={() => {
              void handleContinue();
            }}
            disabled={!canContinue}
            loading={saving}
            accessibilityLabel="Continue"
          />
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={tonePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setTonePickerOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable
            style={styles.modalBackdropFill}
            onPress={() => setTonePickerOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss tone picker"
          />
          <View style={styles.modalSheetEnd} pointerEvents="box-none">
            <View style={styles.modalSheetCard}>
              <View style={styles.modalSheetContent}>
                <Text style={styles.modalTitle}>Tone</Text>
                {TONE_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt}
                    style={({ pressed }) => [
                      styles.modalRow,
                      tone === opt && styles.modalRowActive,
                      pressed && styles.modalRowPressed,
                    ]}
                    onPress={() => {
                      setTone(opt);
                      setTonePickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.modalRowText,
                        tone === opt && styles.modalRowTextActive,
                      ]}
                    >
                      {formatToneLabel(opt)}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View
                style={[
                  styles.modalSheetActions,
                  { paddingBottom: toneModalActionsBottom },
                ]}
              >
                <Pressable
                  style={styles.modalCancel}
                  onPress={() => setTonePickerOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  authLoading: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Brand.backgroundSoft,
  },
  safe: {
    flex: 1,
    backgroundColor: Brand.backgroundSoft,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 24,
    paddingTop: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    color: "#0F172A",
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  lead: {
    fontSize: 15,
    color: "#64748B",
    lineHeight: 22,
    marginBottom: 24,
  },
  feedbackError: {
    color: "#DC2626",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  feedbackSuccess: {
    color: "#15803D",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  field: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#334155",
    marginBottom: 8,
  },
  req: {
    color: "#DC2626",
  },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 16,
    color: "#0F172A",
  },
  textArea: {
    minHeight: 100,
    paddingTop: 14,
    lineHeight: 22,
  },
  textAreaSm: {
    minHeight: 72,
    paddingTop: 14,
    lineHeight: 22,
  },
  select: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
  },
  selectPressed: {
    opacity: 0.92,
  },
  selectDisabled: {
    opacity: 0.55,
  },
  selectText: {
    fontSize: 16,
    color: "#0F172A",
    fontWeight: "500",
  },
  selectChevron: {
    fontSize: 14,
    color: "#64748B",
  },
  footer: {
    paddingHorizontal: 22,
    paddingBottom: Platform.OS === "ios" ? 12 : 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Brand.cardBorder,
    backgroundColor: Brand.backgroundSoft,
  },
  modalRoot: {
    flex: 1,
  },
  modalBackdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.45)",
  },
  modalSheetEnd: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalSheetCard: {
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  modalSheetContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  modalSheetActions: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  modalTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  modalRow: {
    paddingVertical: 14,
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  modalRowActive: {
    backgroundColor: "rgba(124, 58, 237, 0.08)",
  },
  modalRowPressed: {
    opacity: 0.85,
  },
  modalRowText: {
    fontSize: 17,
    color: "#0F172A",
  },
  modalRowTextActive: {
    fontWeight: "700",
    color: Brand.tint,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: "center",
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#64748B",
  },
});
