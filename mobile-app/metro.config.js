// Prefer React Native builds for packages like firebase/auth on native
// platforms (fixes auth/configuration-not-found) -- scoped to ios/android
// only. It must NOT apply to web: firebase/auth's own package.json exports
// map lists "react-native" before "browser" in its own key order, so if
// "react-native" is present in the resolved condition set AT ALL (regardless
// of where it appears in our own list), Metro's exports-conditions
// resolution picks the React Native build even when bundling for web. That
// build defaults Firebase Auth to in-memory-only persistence and silently
// loses the session on every page reload/tab switch, no matter what
// `persistence` option firebase.js passes to initializeAuth.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.unstable_conditionNames = ["browser", "require"];
config.resolver.unstable_conditionsByPlatform = {
  ...config.resolver.unstable_conditionsByPlatform,
  ios: ["react-native"],
  android: ["react-native"],
};

module.exports = config;
