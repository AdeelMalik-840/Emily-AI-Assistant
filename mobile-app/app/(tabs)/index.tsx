import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useFocusEffect } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { WhatsAppConnectModal } from "@/components/WhatsAppConnectModal";
import { DS } from "@/constants/designSystem";
import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/firebase";
import { useManualWhatsAppConnection } from "@/hooks/useManualWhatsAppConnection";

export default function HomeScreen() {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.uid ?? null;
  const {
    status: waStatus,
    phone: displayPhone,
    loading: waStatusLoading,
  } = useManualWhatsAppConnection(userId);

  const [profileLoading, setProfileLoading] = useState(true);
  const [suggestedPhone, setSuggestedPhone] = useState<string | null>(null);
  const [waModal, setWaModal] = useState<"closed" | "connect" | "manage">(
    "closed"
  );

  // Business-profile prefill only -- never treated as connection truth.
  // Connected/ready comes from businesses/{uid} after backend confirm.
  const loadProfileSuggestion = useCallback(async () => {
    if (!userId) {
      setSuggestedPhone(null);
      setProfileLoading(false);
      return;
    }
    setProfileLoading(true);
    try {
      const snap = await getDoc(doc(db, "businesses", userId));
      const data = snap.data() as
        | {
            ownerNotificationPhone?: string;
            businessProfile?: { ownerNotificationPhone?: string };
          }
        | undefined;
      const suggestion =
        data?.businessProfile?.ownerNotificationPhone?.trim() ||
        data?.ownerNotificationPhone?.trim() ||
        null;
      setSuggestedPhone(suggestion || null);
    } catch {
      setSuggestedPhone(null);
    } finally {
      setProfileLoading(false);
    }
  }, [userId]);

  useFocusEffect(
    useCallback(() => {
      void loadProfileSuggestion();
    }, [loadProfileSuggestion])
  );

  const whatsappConnected = waStatus === "connected";
  const whatsappPending = waStatus === "pending";

  const loading = authLoading || profileLoading || waStatusLoading;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <WhatsAppConnectModal
        key={userId ?? "signed-out"}
        visible={waModal !== "closed"}
        businessId={userId}
        suggestedPhone={suggestedPhone}
        manageOnly={waModal === "manage"}
        onClose={() => setWaModal("closed")}
      />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.pageTitle}>Home</Text>
          <Text style={styles.pageSubtitle}>
            {whatsappConnected
              ? "Emily is ready"
              : whatsappPending
                ? "WhatsApp is connecting"
                : "Connect WhatsApp to get Emily ready"}
          </Text>
        </View>

        {!loading ? (
          <>
            <View style={styles.statusBlock}>
              <Text style={styles.instruction}>
                {whatsappConnected
                  ? "Your channel is active."
                  : whatsappPending
                    ? "Your number is registered. Emily will be ready after confirmation."
                    : "Connect your first channel to get started"}
              </Text>
            </View>

            <Text style={styles.sectionLabel}>Channels</Text>

            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.iconWrap}>
                  <FontAwesome
                    name="whatsapp"
                    size={18}
                    color={DS.color.accent}
                  />
                </View>
                <View style={styles.cardCopy}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle}>WhatsApp</Text>
                    {whatsappConnected ? (
                      <View style={styles.statusBadge}>
                        <Text style={styles.statusBadgeText}>Connected</Text>
                      </View>
                    ) : whatsappPending ? (
                      <View style={styles.statusBadge}>
                        <Text style={styles.statusBadgeText}>Connecting</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.cardDesc}>
                    Connect your business WhatsApp so Emily can reply to
                    customers
                  </Text>
                </View>
              </View>

              {whatsappPending ? (
                <>
                  <Text style={styles.cardFooterLine}>
                    Waiting for confirmation…
                  </Text>
                  <Pressable
                    onPress={() => setWaModal("connect")}
                    style={({ pressed }) => [
                      styles.btnPrimary,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="View WhatsApp connection status"
                  >
                    <Text style={styles.btnPrimaryText}>View status</Text>
                  </Pressable>
                </>
              ) : !whatsappConnected ? (
                <>
                  <Pressable
                    onPress={() => setWaModal("connect")}
                    style={({ pressed }) => [
                      styles.btnPrimary,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Connect your WhatsApp"
                  >
                    <Text style={styles.btnPrimaryText}>
                      Connect your WhatsApp →
                    </Text>
                  </Pressable>
                  <Text style={styles.cardFooterLine}>
                    Enter your business WhatsApp number
                  </Text>
                </>
              ) : (
                <View style={styles.connected}>
                  <Text style={styles.phone}>{displayPhone || "—"}</Text>
                  <Pressable
                    onPress={() => setWaModal("manage")}
                    style={({ pressed }) => [
                      styles.btnManage,
                      styles.btnManagePill,
                      pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Manage WhatsApp"
                  >
                    <Text style={styles.btnManageText}>Manage</Text>
                  </Pressable>
                </View>
              )}
            </View>
          </>
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color={DS.color.textSecondary} />
          </View>
        )}

        <Text style={styles.comingSoonHeading}>Coming soon</Text>

        <View style={styles.comingSoonList}>
          <View style={styles.comingSoonCard}>
            <View style={styles.comingSoonLeft}>
              <Text style={styles.comingSoonTitle}>Outbound Calling Agent</Text>
              <Text style={styles.comingSoonDesc}>
                Emily can call your leads and follow up automatically
              </Text>
            </View>
            <Text style={styles.comingSoonHint}>Coming soon</Text>
          </View>

          <View style={styles.comingSoonCard}>
            <View style={styles.comingSoonLeft}>
              <Text style={styles.comingSoonTitle}>Email</Text>
              <Text style={styles.comingSoonDesc}>
                Handle customer emails automatically
              </Text>
            </View>
            <Text style={styles.comingSoonHint}>Coming soon</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  scroll: {
    paddingHorizontal: DS.space.lg,
    paddingBottom: DS.space.xxl,
    paddingTop: DS.space.xs,
  },
  header: {
    marginBottom: DS.space.xl,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: "600",
    color: "#000000",
    letterSpacing: -0.4,
    marginBottom: 10,
  },
  pageSubtitle: {
    fontSize: 15,
    fontWeight: "400",
    color: "#3A3A3C",
    lineHeight: 22,
  },
  statusBlock: {
    marginBottom: 32,
  },
  instruction: {
    marginTop: 0,
    fontSize: 15,
    fontWeight: "400",
    color: "#3A3A3C",
    lineHeight: 22,
    maxWidth: 320,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#6B6B6B",
    marginBottom: DS.space.sm,
    marginTop: 4,
    letterSpacing: 0.65,
    textTransform: "uppercase",
  },
  loading: {
    paddingVertical: DS.space.xxl,
    alignItems: "center",
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: DS.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5E5EA",
    padding: DS.space.md,
    marginBottom: 40,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
    marginBottom: DS.space.md,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: DS.radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(37, 211, 102, 0.09)",
  },
  cardCopy: {
    flex: 1,
    minWidth: 0,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#000000",
    letterSpacing: -0.2,
  },
  statusBadge: {
    backgroundColor: "rgba(37, 211, 102, 0.12)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "600",
    color: DS.color.accent,
    letterSpacing: 0.2,
  },
  cardDesc: {
    fontSize: 14,
    fontWeight: "400",
    color: "#6B6B6B",
    lineHeight: 20,
  },
  reconnectNotice: {
    fontSize: 13,
    fontWeight: "500",
    color: DS.color.destructive,
    marginBottom: DS.space.sm,
  },
  btnPrimary: {
    backgroundColor: "#3A3A3C",
    borderRadius: 8,
    paddingVertical: 9,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimaryText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#FFFFFF",
    letterSpacing: -0.1,
  },
  cardFooterLine: {
    marginTop: DS.space.sm,
    fontSize: 12,
    fontWeight: "400",
    color: "#8E8E93",
    textAlign: "center",
  },
  pressed: {
    opacity: DS.pressOpacity,
  },
  connected: {
    gap: DS.space.sm,
  },
  phone: {
    fontSize: 16,
    fontWeight: "500",
    color: "#3A3A3C",
  },
  btnManage: {
    alignSelf: "flex-start",
    marginTop: 4,
  },
  btnManagePill: {
    backgroundColor: "#3A3A3C",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    minWidth: 120,
    alignItems: "center",
  },
  btnManageText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#FFFFFF",
  },
  comingSoonHeading: {
    fontSize: 11,
    fontWeight: "600",
    color: "#6B6B6B",
    textTransform: "uppercase",
    letterSpacing: 0.65,
    marginBottom: DS.space.sm,
    marginTop: 4,
  },
  comingSoonList: {
    gap: DS.space.sm,
  },
  comingSoonCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: DS.space.sm,
    backgroundColor: "#F5F5F7",
    borderRadius: DS.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 0,
  },
  comingSoonLeft: {
    flex: 1,
    minWidth: 0,
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: "500",
    color: "#6B6B6B",
    marginBottom: 4,
  },
  comingSoonDesc: {
    fontSize: 13,
    fontWeight: "400",
    color: "#8E8E93",
    lineHeight: 18,
  },
  comingSoonHint: {
    fontSize: 10,
    fontWeight: "500",
    color: "#AEAEB2",
    marginTop: 2,
    letterSpacing: 0.55,
    textTransform: "uppercase",
  },
});
