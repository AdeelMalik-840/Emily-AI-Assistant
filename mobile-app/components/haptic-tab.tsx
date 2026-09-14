import { PlatformPressable } from "@react-navigation/elements";
import type { BottomTabBarButtonProps } from "@react-navigation/bottom-tabs";
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/**
 * Tab bar button with optional light haptic on press (iOS only).
 *
 * Built on PlatformPressable (the same base React Navigation's own default
 * tab bar button uses -- BottomTabBarButtonProps is typed directly as its
 * props) rather than a plain TouchableOpacity. This matters specifically on
 * web: PlatformPressable's onPress handler explicitly calls
 * e.preventDefault() before invoking the navigator's onPress, which is what
 * stops the tab's `href` anchor from also triggering a real browser
 * navigation (a full page reload -- and with it, loss of any auth state
 * that isn't durably persisted). TouchableOpacity has no such handling, so
 * spreading `href` onto it left the underlying anchor's native navigation
 * unsuppressed.
 */
export function HapticTab(props: BottomTabBarButtonProps) {
  const { onPressIn, ...rest } = props;

  return (
    <PlatformPressable
      {...rest}
      onPressIn={(e) => {
        if (Platform.OS === "ios") {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
        onPressIn?.(e);
      }}
    />
  );
}
