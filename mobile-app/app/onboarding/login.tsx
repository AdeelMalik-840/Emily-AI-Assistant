
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
} from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

import { GradientButton } from "@/components/ui/GradientButton";
import { Brand } from "@/constants/brand";
import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { checkBusinessProfile } from "@/lib/checkBusiness";
import {
  auth,
  clearStoredEmailForSignIn,
  getEmailLinkActionCodeSettings,
  getStoredEmailForSignIn,
  storeEmailForSignIn,
} from "@/firebase";
import { EMAIL_LINK_LAST_ERROR_KEY } from "@/utils/emailLinkAuth";

function isValidEmailFormat(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

export default function OnboardingLoginScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { user, loading: authLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [sentToEmail, setSentToEmail] = useState("");
  const [pastedSignInLink, setPastedSignInLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [emailSendLoading, setEmailSendLoading] = useState(false);
  const [completeLoading, setCompleteLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [showTroubleshoot, setShowTroubleshoot] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const completingRef = useRef(false);
  const sendInFlightRef = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown > 0]);

  useEffect(() => {
    void (async () => {
      const flag = await AsyncStorage.getItem(EMAIL_LINK_LAST_ERROR_KEY);
      if (flag === "no_email") {
        setError(
          "We opened your sign-in link, but the email wasn’t saved on this device. Enter the same email below and request a new link, or paste the link manually."
        );
        await AsyncStorage.removeItem(EMAIL_LINK_LAST_ERROR_KEY);
      } else if (flag === "invalid_or_expired") {
        setError(
          "That sign-in link is invalid or has already been used. Enter your email to request a new one."
        );
        await AsyncStorage.removeItem(EMAIL_LINK_LAST_ERROR_KEY);
      }
    })();
  }, []);

  const handleUseDifferentEmail = useCallback(() => {
    setLinkSent(false);
    setShowTroubleshoot(false);
    setPastedSignInLink("");
    setSuccessMessage(null);
    setError(null);
    setCooldown(0);
    void clearStoredEmailForSignIn();
  }, []);

  const handleCompleteSignIn = useCallback(async () => {
    if (auth.currentUser) return;
    if (completingRef.current) return;

    completingRef.current = true;
    Keyboard.dismiss();
    setCompleteLoading(true);
    setError(null);
    try {
      const url = pastedSignInLink.trim();
      if (!url) {
        setError("Paste your sign-in link first.");
        console.log("❌ Complete sign-in: empty link");
        return;
      }

      if (!isSignInWithEmailLink(auth, url)) {
        setError("Invalid sign-in link");
        console.log("❌ Complete sign-in: not a valid email link URL");
        return;
      }

      const stored = await getStoredEmailForSignIn();
      const emailForLink = (stored || email.trim()) || "";
      if (!emailForLink) {
        setError("Enter the email you used for the sign-in link.");
        console.log("❌ Complete sign-in: no stored email and empty field");
        return;
      }

      console.log("🔗 Completing sign-in with link:", url.substring(0, 120) + (url.length > 120 ? "…" : ""));
      await signInWithEmailLink(auth, emailForLink, url);
      await clearStoredEmailForSignIn();
      await AsyncStorage.removeItem(EMAIL_LINK_LAST_ERROR_KEY);
      console.log("✅ Login success (email link paste)");
      console.log("✅ signInWithEmailLink completed");
      setPastedSignInLink("");
      setLinkSent(false);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      console.log(
        "❌ Complete sign-in error:",
        err.code ?? "unknown",
        err.message ?? e
      );
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setCompleteLoading(false);
      completingRef.current = false;
    }
  }, [email, pastedSignInLink]);

  useEffect(() => {
    if (authLoading) return;
    if (!user?.email) return;

    let cancelled = false;
    void (async () => {
      console.log("[login] Signed in, checking business profile…");
      const hasBusiness = await checkBusinessProfile(user.uid);
      if (cancelled) return;
      if (hasBusiness) {
        console.log("✅ Login success → main app (tabs)");
        router.replace("/(tabs)");
      } else {
        console.log("✅ Login success → /business (setup)");
        router.replace(routes.business);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.uid, user?.email, authLoading]);

  const handleContinueWithEmail = useCallback(async () => {
    if (emailSendLoading || cooldown > 0) {
      console.log("📧 Send blocked: loading or cooldown");
      return;
    }
    if (sendInFlightRef.current) return;

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Please enter your email.");
      console.log("❌ Validation: empty email");
      return;
    }
    if (!isValidEmailFormat(trimmed)) {
      setError("Please enter a valid email address.");
      console.log("❌ Validation: bad email format:", trimmed);
      return;
    }

    setError(null);
    setSuccessMessage(null);
    Keyboard.dismiss();
    sendInFlightRef.current = true;
    setEmailSendLoading(true);

    const actionCodeSettings = getEmailLinkActionCodeSettings();
    console.log("📧 actionCodeSettings.url:", actionCodeSettings.url);
    console.log("📧 Sending email to:", trimmed);

    const wasAlreadySent = linkSent;
    try {
      await sendSignInLinkToEmail(auth, trimmed, actionCodeSettings);
      console.log("✅ Email send request successful");
      await storeEmailForSignIn(trimmed);
      setSentToEmail(trimmed);
      setLinkSent(true);
      setSuccessMessage(wasAlreadySent ? "New sign-in link sent." : null);
      setCooldown(30);
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      console.log(
        "❌ Email send error:",
        err.code ?? "unknown",
        err.message ?? error
      );
      if (err.code === "auth/quota-exceeded") {
        setError("Too many requests. Please try again later.");
      } else if (err.code === "auth/too-many-requests") {
        setError("Too many attempts. Please wait a few minutes.");
      } else if (err.code === "auth/invalid-email") {
        setError("Invalid email address.");
      } else if (err.code === "auth/operation-not-allowed") {
        setError("Email login is not enabled in Firebase.");
      } else {
        setError(
          err.message ?? "Failed to send email. Please try again."
        );
      }
    } finally {
      setEmailSendLoading(false);
      sendInFlightRef.current = false;
    }
  }, [email, emailSendLoading, cooldown, linkSent]);

  if (authLoading) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  if (user) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  /** At least one viewport tall so short content centers; grows with tall content so scroll starts at top. */
  const centeredBlockMinHeight =
    windowHeight - insets.top - insets.bottom - 8;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingBottom: Math.max(32, insets.bottom + 16),
            },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
        >
          <View
            style={[
              styles.centeredBlock,
              { minHeight: Math.max(0, centeredBlockMinHeight) },
            ]}
          >
            <View style={styles.inner}>
              {!linkSent ? (
                <>
                  <Text style={styles.title}>Continue with Email</Text>
                  <Text style={styles.lead}>
                    We&apos;ll email you a sign-in link. No password needed.
                  </Text>

                  <View style={styles.field}>
                    <Text style={styles.label}>Email</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="you@example.com"
                      placeholderTextColor="#94A3B8"
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={email}
                      onChangeText={setEmail}
                      editable={!emailSendLoading}
                      returnKeyType="done"
                      blurOnSubmit
                      onSubmitEditing={Keyboard.dismiss}
                    />
                  </View>

                  {error ? <Text style={styles.error}>{error}</Text> : null}

                  <GradientButton
                    title={emailSendLoading ? "Sending..." : "Continue with Email"}
                    onPress={() => {
                      void handleContinueWithEmail();
                    }}
                    disabled={emailSendLoading || !email.trim()}
                    loading={emailSendLoading}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.title}>Check your email</Text>
                  <Text style={styles.lead}>
                    We sent a sign-in link to{"\n"}
                    <Text style={styles.emailHighlight}>{sentToEmail}</Text>
                  </Text>
                  <Text style={styles.instructions}>
                    {Platform.OS === "web"
                      ? "Open the link in this browser to continue."
                      : "Tap the link on this phone — the app will open and sign you in automatically."}
                  </Text>

                  {error ? <Text style={styles.error}>{error}</Text> : null}
                  {successMessage ? (
                    <Text style={styles.success}>{successMessage}</Text>
                  ) : null}

                  <GradientButton
                    title={
                      emailSendLoading
                        ? "Sending..."
                        : cooldown > 0
                          ? `Resend in ${cooldown}s`
                          : "Resend email"
                    }
                    onPress={() => {
                      void handleContinueWithEmail();
                    }}
                    disabled={emailSendLoading || cooldown > 0}
                    loading={emailSendLoading}
                  />

                  <Pressable
                    onPress={handleUseDifferentEmail}
                    disabled={emailSendLoading || completeLoading}
                    style={styles.linkBtn}
                  >
                    <Text style={styles.linkText}>Use a different email</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setShowTroubleshoot((v) => !v)}
                    style={styles.linkBtn}
                  >
                    <Text style={styles.linkText}>
                      {showTroubleshoot
                        ? "Hide troubleshooting"
                        : "Having trouble signing in?"}
                    </Text>
                  </Pressable>

                  {showTroubleshoot ? (
                    <View style={styles.troubleshoot}>
                      <Text style={styles.troubleshootLead}>
                        If the link didn&apos;t open this app automatically,
                        paste it below.
                      </Text>
                      <View style={styles.field}>
                        <Text style={styles.label}>Paste sign-in link</Text>
                        <TextInput
                          style={[styles.input, styles.pasteInput]}
                          placeholder="https://..."
                          placeholderTextColor="#94A3B8"
                          autoCapitalize="none"
                          autoCorrect={false}
                          multiline
                          value={pastedSignInLink}
                          onChangeText={setPastedSignInLink}
                          editable={!completeLoading}
                          returnKeyType="done"
                          blurOnSubmit
                          onSubmitEditing={Keyboard.dismiss}
                        />
                      </View>
                      <View style={styles.secondaryBtn}>
                        <GradientButton
                          title="Complete Sign-in (paste only)"
                          onPress={() => {
                            void handleCompleteSignIn();
                          }}
                          disabled={completeLoading || !pastedSignInLink.trim()}
                          loading={completeLoading}
                        />
                      </View>
                    </View>
                  ) : null}
                </>
              )}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: Brand.background,
  },
  safe: {
    flex: 1,
    backgroundColor: Brand.background,
  },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingTop: 16,
  },
  centeredBlock: {
    justifyContent: "center",
  },
  inner: {
    paddingHorizontal: 24,
    gap: 14,
  },
  secondaryBtn: {
    marginTop: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: Brand.text,
    letterSpacing: -0.5,
  },
  lead: {
    fontSize: 15,
    color: Brand.textSecondary,
    lineHeight: 22,
    marginBottom: 8,
  },
  instructions: {
    fontSize: 14,
    color: "#15803D",
    lineHeight: 20,
  },
  field: { gap: 6 },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#475569",
  },
  input: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 16,
    color: Brand.text,
    backgroundColor: "#FAFAFA",
  },
  pasteInput: {
    minHeight: 88,
    paddingTop: Platform.OS === "ios" ? 14 : 12,
    textAlignVertical: "top",
  },
  error: {
    color: "#DC2626",
    fontSize: 14,
  },
  success: {
    color: "#15803D",
    fontSize: 14,
    lineHeight: 20,
  },
  emailHighlight: {
    fontWeight: "700",
    color: Brand.text,
  },
  linkBtn: {
    paddingVertical: 6,
    alignSelf: "flex-start",
  },
  linkText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#7C3AED",
  },
  troubleshoot: {
    gap: 10,
    marginTop: 4,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#E2E8F0",
  },
  troubleshootLead: {
    fontSize: 13,
    color: Brand.textSecondary,
    lineHeight: 18,
  },
});
