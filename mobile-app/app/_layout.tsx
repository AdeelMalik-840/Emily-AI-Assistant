import { DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { Stack, router, useSegments } from "expo-router";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import * as WebBrowser from "expo-web-browser";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import "react-native-reanimated";

import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { db } from "@/firebase";
import { recordWhatsAppOAuthDeepLink } from "@/services/whatsappOAuthDeepLinkStore";
import { subscribePendingWriteSync } from "@/utils/firestoreOfflineQueue";

void SplashScreen.preventAutoHideAsync();
void WebBrowser.maybeCompleteAuthSession();

/** Light iOS-style headers for any stack screen with `headerShown: true`. */
const stackHeaderLight = {
  headerStyle: {
    backgroundColor: "#FFFFFF",
  },
  headerTitleStyle: {
    color: "#000000",
    fontWeight: "600" as const,
  },
  headerTintColor: "#000000",
  headerShadowVisible: false,
};

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * Wait for auth before mounting the Stack. When signed out and not on an
 * onboarding screen, redirect to login via useEffect only (no dismissAll).
 */
function AuthGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const segments = useSegments();

  useEffect(() => {
    if (!loading) {
      void SplashScreen.hideAsync();
    }
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    if (user?.email) return;
    const inOnboarding = segments[0] === "onboarding";
    if (inOnboarding) return;
    router.replace("/onboarding/login");
  }, [loading, user?.email, segments]);

  if (loading) {
    return (
      <View style={styles.authBoot}>
        <ActivityIndicator size="large" color="#7C3AED" />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (url) recordWhatsAppOAuthDeepLink(url);
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      recordWhatsAppOAuthDeepLink(url);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return subscribePendingWriteSync(db);
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync("#FFFFFF");
  }, []);

  return (
    <AuthProvider>
      <AuthGate>
        <ThemeProvider value={DefaultTheme}>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: "fade",
              ...stackHeaderLight,
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="onboarding" options={{ animation: "fade" }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="whatsapp-connected" />
            <Stack.Screen
              name="business"
              options={{
                headerShown: true,
                title: "Business Setup",
                headerBackTitle: "Settings",
              }}
            />
            <Stack.Screen
              name="modal"
              options={{
                presentation: "modal",
                title: "Modal",
                headerShown: true,
              }}
            />
          </Stack>
          <StatusBar style="dark" />
        </ThemeProvider>
      </AuthGate>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  authBoot: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
});
