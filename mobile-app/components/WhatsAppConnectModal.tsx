import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import PhoneInput from "react-native-phone-number-input";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useManualWhatsAppConnection } from "@/hooks/useManualWhatsAppConnection";

const BG = "#FFFFFF";

type Props = {
  visible: boolean;
  onClose: () => void;
  businessId: string | null;
  /** Prefill only -- the user must confirm/edit before it is used. */
  suggestedPhone?: string | null;
  /** Opens straight into the manage/disconnect view instead of the connect flow. */
  manageOnly?: boolean;
};

function friendlyError(message: string | undefined): string {
  const m = String(message ?? "").trim();
  return m !== "" ? m : "Something went wrong. Please try again.";
}

/** ISO 3166-1 alpha-2 -> regional-indicator flag emoji. */
function regionalIndicatorFlagEmoji(iso2: string): string {
  const u = String(iso2)
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (u.length !== 2) return "";
  const base = 0x1f1e6;
  const a = u.charCodeAt(0);
  const b = u.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "";
  return String.fromCodePoint(base + a - 65, base + b - 65);
}

export function WhatsAppConnectModal({
  visible,
  onClose,
  businessId,
  suggestedPhone,
  manageOnly = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const actionsBottomPad = Math.max(20, insets.bottom);

  const {
    status,
    phone: connectedPhone,
    loading: statusLoading,
    submitting: hookSubmitting,
    submitPhone,
    disconnect,
  } = useManualWhatsAppConnection(businessId);

  const [phoneInput, setPhoneInput] = useState(suggestedPhone ?? "");
  const [phoneInputMountKey, setPhoneInputMountKey] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const submitting = localSubmitting || hookSubmitting;

  useEffect(() => {
    if (visible) {
      setPhoneInput(suggestedPhone ?? "");
      setPhoneInputMountKey((k) => k + 1);
      setSubmitError(null);
      setConfirmingDisconnect(false);
      setDisconnecting(false);
    }
  }, [visible, suggestedPhone]);

  const blockingBackdrop =
    submitting ||
    statusLoading ||
    status === "pending" ||
    disconnecting ||
    confirmingDisconnect;

  const handleBackdrop = () => {
    if (blockingBackdrop) return;
    onClose();
  };

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    setLocalSubmitting(true);
    try {
      await submitPhone(phoneInput);
    } catch (err) {
      setSubmitError(friendlyError(err instanceof Error ? err.message : undefined));
    } finally {
      setLocalSubmitting(false);
    }
  }, [phoneInput, submitPhone]);

  const handleDisconnect = useCallback(async () => {
    setSubmitError(null);
    setDisconnecting(true);
    try {
      await disconnect();
      onClose();
    } catch (err) {
      setSubmitError(friendlyError(err instanceof Error ? err.message : undefined));
    } finally {
      setDisconnecting(false);
      setConfirmingDisconnect(false);
    }
  }, [disconnect, onClose]);

  const renderPhonePickerFlag = useCallback(
    (pickerProps: { countryCode: string }) => (
      <View style={styles.phoneFlagButtonInner}>
        <Text style={styles.phoneFlagEmoji} allowFontScaling={false}>
          {regionalIndicatorFlagEmoji(pickerProps.countryCode)}
        </Text>
      </View>
    ),
    []
  );

  const renderManage = () => {
    if (confirmingDisconnect) {
      return (
        <>
          <View style={styles.sheetContent}>
            <Text style={styles.title}>Disconnect WhatsApp?</Text>
            <Text style={styles.subtitle}>
              Emily will stop responding on this number. You can reconnect
              anytime.
            </Text>
          </View>
          <View style={[styles.sheetActions, { paddingBottom: actionsBottomPad }]}>
            <View style={styles.manageActions}>
              <Pressable
                onPress={() => setConfirmingDisconnect(false)}
                style={({ pressed }) => [styles.secondaryCta, pressed && styles.secondaryCtaPressed]}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.secondaryCtaText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void handleDisconnect()}
                style={({ pressed }) => [styles.destructiveCta, pressed && styles.destructiveCtaPressed]}
                accessibilityRole="button"
                accessibilityLabel="Disconnect WhatsApp"
              >
                <Text style={styles.destructiveCtaText}>Disconnect</Text>
              </Pressable>
            </View>
          </View>
        </>
      );
    }

    if (disconnecting) {
      return (
        <View style={styles.sheetContent}>
          <View style={styles.centerBlock} pointerEvents="none">
            <ActivityIndicator size="large" color="#3A3A3C" />
            <Text style={styles.loadingTitle}>Disconnecting…</Text>
          </View>
        </View>
      );
    }

    const displayPhone = connectedPhone;

    return (
      <>
        <View style={styles.sheetContent}>
          <Text style={styles.title}>WhatsApp</Text>
          <Text style={styles.subtitle}>
            {displayPhone ? "Your business number" : "No number on file"}
          </Text>
          {displayPhone ? <Text style={styles.phoneDisplay}>{displayPhone}</Text> : null}
          {submitError ? <Text style={styles.errorInline}>{submitError}</Text> : null}
          <Pressable
            onPress={() => setConfirmingDisconnect(true)}
            style={({ pressed }) => [styles.disconnectLink, pressed && styles.disconnectLinkPressed]}
            accessibilityRole="button"
            accessibilityLabel="Disconnect WhatsApp"
          >
            <Text style={styles.disconnectLinkText}>Disconnect WhatsApp</Text>
          </Pressable>
        </View>
        <View style={[styles.sheetActions, { paddingBottom: actionsBottomPad }]}>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <Text style={styles.ctaText}>Done</Text>
          </Pressable>
        </View>
      </>
    );
  };

  const renderConnectFlow = () => {
    if (statusLoading) {
      return (
        <View style={styles.sheetContent}>
          <View style={styles.centerBlock} pointerEvents="none">
            <ActivityIndicator size="large" color="#3A3A3C" />
          </View>
        </View>
      );
    }

    if (submitting) {
      return (
        <View style={styles.sheetContent}>
          <View style={styles.centerBlock} pointerEvents="none">
            <ActivityIndicator size="large" color="#3A3A3C" />
            <Text style={styles.loadingTitle}>Saving your number…</Text>
          </View>
        </View>
      );
    }

    if (status === "pending") {
      return (
        <View style={styles.sheetContent}>
          <Text style={styles.title}>Connecting WhatsApp</Text>
          <Text style={styles.subtitle}>
            Your number is registered. Emily will show as ready once this
            connection is confirmed.
          </Text>
          {connectedPhone ? (
            <Text style={styles.phoneDisplay}>{connectedPhone}</Text>
          ) : null}
          <View style={styles.waitingRow}>
            <ActivityIndicator size="small" color="#8E8E93" />
            <Text style={styles.waitingText}>Waiting for confirmation…</Text>
          </View>
        </View>
      );
    }

    if (status === "connected") {
      return (
        <>
          <View style={styles.sheetContent}>
            <Text style={styles.successHeadline}>{"✓ WhatsApp connected"}</Text>
            <Text style={styles.subtitle}>
              Emily is ready to handle your customer conversations.
            </Text>
          </View>
          <View style={[styles.sheetActions, { paddingBottom: actionsBottomPad }]}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
              accessibilityRole="button"
              accessibilityLabel="Continue"
            >
              <Text style={styles.ctaText}>Continue</Text>
            </Pressable>
          </View>
        </>
      );
    }

    return (
      <>
        <View style={styles.sheetContent}>
          <Text style={styles.title}>Connect WhatsApp</Text>
          <Text style={styles.subtitle}>
            Connect the WhatsApp number you use for your business.
          </Text>
          {submitError ? <Text style={styles.errorInline}>{submitError}</Text> : null}
          <PhoneInput
            key={phoneInputMountKey}
            defaultCode="PK"
            defaultValue={suggestedPhone ?? undefined}
            layout="first"
            placeholder="Enter your WhatsApp number"
            onChangeFormattedText={setPhoneInput}
            containerStyle={styles.phoneInputContainer}
            textContainerStyle={styles.phoneInputTextContainer}
            textInputStyle={styles.phoneInputText}
            flagButtonStyle={styles.phoneInputFlagButton}
            countryPickerProps={{ renderFlagButton: renderPhonePickerFlag }}
            textInputProps={{
              placeholderTextColor: "#8E8E93",
              keyboardType: "phone-pad",
              autoComplete: "tel",
              textContentType: "telephoneNumber",
              accessibilityLabel: "WhatsApp phone number",
            }}
          />
          {suggestedPhone ? (
            <Text style={styles.suggestionHint}>
              We prefilled the number from your business profile -- confirm
              or edit it above.
            </Text>
          ) : null}
        </View>
        <View style={[styles.sheetActions, { paddingBottom: actionsBottomPad }]}>
          <Pressable
            onPress={() => void handleSubmit()}
            disabled={submitting}
            style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
            accessibilityRole="button"
            accessibilityLabel="Continue"
          >
            <Text style={styles.ctaText}>Continue</Text>
          </Pressable>
        </View>
      </>
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={blockingBackdrop ? () => {} : onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.backdrop}
          onPress={handleBackdrop}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View style={styles.sheetEnd}>
          <View style={styles.sheetCard}>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              {manageOnly ? renderManage() : renderConnectFlow()}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheetEnd: { flex: 1, justifyContent: "flex-end" },
  sheetCard: {
    width: "100%",
    backgroundColor: BG,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "92%",
  },
  sheetContent: { paddingHorizontal: 20, paddingTop: 20 },
  sheetActions: { paddingHorizontal: 20, paddingTop: 12 },
  sheetActionsColumn: { gap: 12 },
  title: {
    fontSize: 20,
    fontWeight: "600",
    color: "#000000",
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    fontWeight: "500",
    color: "#3A3A3C",
    lineHeight: 22,
    marginBottom: 20,
  },
  suggestionHint: {
    fontSize: 13,
    fontWeight: "400",
    color: "#8E8E93",
    lineHeight: 18,
    marginTop: -8,
    marginBottom: 12,
  },
  errorInline: {
    fontSize: 14,
    fontWeight: "500",
    color: "#DC2626",
    marginBottom: 12,
  },
  successHeadline: {
    fontSize: 22,
    fontWeight: "600",
    color: "#000000",
    letterSpacing: -0.3,
    marginBottom: 12,
  },
  codeBlock: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F2F2F7",
    borderRadius: 12,
    paddingVertical: 20,
    marginBottom: 16,
  },
  codeText: {
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 4,
    color: "#000000",
  },
  codeInstructions: {
    fontSize: 15,
    fontWeight: "500",
    color: "#3A3A3C",
    lineHeight: 24,
    marginBottom: 20,
  },
  waitingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 4,
  },
  waitingText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#8E8E93",
  },
  phoneInputContainer: {
    width: "100%",
    minHeight: 52,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5E5EA",
    backgroundColor: "#FFFFFF",
    paddingVertical: 0,
    alignItems: "center",
    overflow: "visible",
  },
  phoneInputFlagButton: {
    marginRight: 8,
    minWidth: 52,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
  },
  phoneFlagButtonInner: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    minWidth: 36,
    minHeight: 28,
  },
  phoneFlagEmoji: { fontSize: 26, lineHeight: 30 },
  phoneInputTextContainer: {
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    paddingVertical: Platform.OS === "ios" ? 10 : 8,
  },
  phoneInputText: { fontSize: 17, color: "#000000" },
  cta: {
    backgroundColor: "#3A3A3C",
    borderRadius: 12,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
  },
  ctaPressed: { opacity: 0.88 },
  ctaText: { fontSize: 17, fontWeight: "600", color: "#FFFFFF" },
  centerBlock: {
    alignItems: "center",
    paddingVertical: 32,
    paddingHorizontal: 8,
  },
  loadingTitle: {
    marginTop: 20,
    fontSize: 17,
    fontWeight: "600",
    color: "#000000",
    textAlign: "center",
  },
  phoneDisplay: {
    fontSize: 20,
    fontWeight: "600",
    color: "#000000",
    marginBottom: 16,
    letterSpacing: -0.2,
  },
  disconnectLink: {
    alignSelf: "flex-start",
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  disconnectLinkPressed: { opacity: 0.65 },
  disconnectLinkText: { fontSize: 17, fontWeight: "600", color: "#FF3B30" },
  manageActions: { flexDirection: "row", gap: 12, width: "100%" },
  secondaryCta: {
    flex: 1,
    minHeight: 50,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5E5EA",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BG,
  },
  secondaryCtaFull: {
    width: "100%",
    minHeight: 50,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5E5EA",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BG,
  },
  secondaryCtaPressed: { opacity: 0.85 },
  secondaryCtaText: { fontSize: 17, fontWeight: "600", color: "#000000" },
  destructiveCta: {
    flex: 1,
    minHeight: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FF3B30",
  },
  destructiveCtaPressed: { opacity: 0.9 },
  destructiveCtaText: { fontSize: 17, fontWeight: "600", color: "#FFFFFF" },
});
