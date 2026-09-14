import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DS } from "@/constants/designSystem";
import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";

function SettingsRow({
  icon,
  label,
  onPress,
  showChevron = true,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  showChevron?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons
        name={icon}
        size={20}
        color="#8E8E93"
        style={styles.rowIcon}
      />
      <Text style={styles.rowLabel}>{label}</Text>
      {showChevron ? (
        <Ionicons name="chevron-forward" size={18} color="#C7C7CC" />
      ) : (
        <View style={styles.rowChevronSpacer} />
      )}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const { signOut } = useAuth();

  const handleLogout = async () => {
    try {
      console.log("👋 Logout: signing out…");
      await signOut();
      console.log("👋 Logout: signed out");
    } catch (error) {
      console.log("❌ Logout error:", error);
    }
  };

  const confirmLogout = () => {
    // react-native-web's Alert.alert() is a no-op (see node_modules/
    // react-native-web/dist/exports/Alert/index.js: `static alert() {}`),
    // so it can never reach handleLogout on web. window.confirm() is the
    // web-safe equivalent; native keeps the existing Alert.alert() dialog
    // unchanged. Either path calls the same handleLogout -- no duplicated
    // logout logic.
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm("Are you sure you want to log out?")) {
        void handleLogout();
      }
      return;
    }
    Alert.alert("Log out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: () => void handleLogout(),
      },
    ]);
  };

  const comingSoon = () => {
    Alert.alert("Coming soon", "This will be available in a future update.");
  };

  const openBusiness = () => {
    router.push(routes.business);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.pageTitle}>Settings</Text>
          <Text style={styles.pageSubtitle}>Account and preferences</Text>
        </View>

        <View style={styles.listBlock}>
          <Text style={styles.sectionLabel}>General</Text>
          <View style={styles.group}>
            <SettingsRow
              icon="briefcase-outline"
              label="Business profile"
              onPress={openBusiness}
            />
            <View style={styles.separator} />
            <SettingsRow
              icon="notifications-outline"
              label="Notifications"
              onPress={comingSoon}
            />
            <View style={styles.separator} />
            <SettingsRow
              icon="color-palette-outline"
              label="Appearance"
              onPress={comingSoon}
            />
          </View>
        </View>

        <View style={styles.listBlock}>
          <Text style={styles.sectionLabel}>Support</Text>
          <View style={styles.group}>
            <SettingsRow
              icon="warning-outline"
              label="Report an issue"
              onPress={comingSoon}
            />
            <View style={styles.separator} />
            <SettingsRow
              icon="help-circle-outline"
              label="FAQ"
              onPress={comingSoon}
            />
          </View>
        </View>

        <Pressable
          onPress={confirmLogout}
          style={({ pressed }) => [styles.logout, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
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
    marginBottom: 6,
  },
  pageSubtitle: {
    fontSize: 15,
    fontWeight: "400",
    color: "#3A3A3C",
    lineHeight: 22,
  },
  listBlock: {
    marginBottom: DS.space.xl,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#6B6B6B",
    textTransform: "uppercase",
    letterSpacing: 0.65,
    marginBottom: DS.space.sm,
  },
  group: {
    backgroundColor: "#FFFFFF",
    borderRadius: DS.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5E5EA",
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: DS.space.md,
    paddingHorizontal: DS.space.md,
    minHeight: 52,
  },
  pressed: {
    opacity: DS.pressOpacity,
  },
  rowIcon: {
    marginRight: DS.space.sm,
    width: 22,
  },
  rowLabel: {
    flex: 1,
    fontSize: 17,
    fontWeight: "400",
    color: "#000000",
    letterSpacing: -0.2,
  },
  rowChevronSpacer: {
    width: 18,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#E5E5EA",
    marginLeft: DS.space.md + 22 + DS.space.sm,
  },
  logout: {
    marginTop: DS.space.md,
    paddingVertical: DS.space.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  logoutText: {
    fontSize: 17,
    fontWeight: "500",
    color: DS.color.destructive,
    letterSpacing: -0.2,
  },
});
