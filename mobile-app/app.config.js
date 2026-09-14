const path = require("path");

// Load env before Expo reads config (Metro inlines EXPO_PUBLIC_* at bundle time).
// Repo root .env first, then mobile-app/.env overrides — so one file can serve both.
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
  /* optional */
}
require("dotenv").config({ path: path.join(__dirname, ".env") });

const appJson = require("./app.json");

module.exports = {
  expo: {
    ...appJson.expo,
    android: {
      ...appJson.expo.android,
      package: "com.adeel.emily",
    },
    ios: {
      ...appJson.expo.ios,
      bundleIdentifier: "com.adeel.emily",
    },
    extra: {
      ...(appJson.expo.extra ?? {}),
      eas: {
        ...(appJson.expo.extra?.eas ?? {}),
        projectId: "4a09d344-1065-4a7e-8053-6d3182d3d13d",
      },
    },
  },
};
