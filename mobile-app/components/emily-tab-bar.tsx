import { BottomTabBar } from "@react-navigation/bottom-tabs";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { StyleSheet, View } from "react-native";

const TAB_BAR_THEME = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: "#000000",
    card: "#FFFFFF",
    border: "#E5E5EA",
    background: "#FFFFFF",
  },
};

/**
 * Plain View behind the stock BottomTabBar so the bar is never “empty”/transparent
 * over a black root view, and ThemeProvider forces light tab colors regardless of
 * the app root ThemeProvider (dark mode).
 */
export function EmilyTabBar(props: BottomTabBarProps) {
  return (
    <ThemeProvider value={TAB_BAR_THEME}>
      <View style={styles.chrome} collapsable={false}>
        <BottomTabBar {...props} />
      </View>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  chrome: {
    backgroundColor: "#FFFFFF",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5E5EA",
  },
});
