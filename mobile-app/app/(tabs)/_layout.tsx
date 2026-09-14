import { Tabs } from "expo-router";
import React from "react";

import { EmilyTabBar } from "@/components/emily-tab-bar";
import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";

const TAB_BG = "#FFFFFF";
const TAB_ACTIVE = "#000000";
const TAB_INACTIVE = "#8E8E93";

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <EmilyTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: TAB_ACTIVE,
        tabBarInactiveTintColor: TAB_INACTIVE,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: "500",
          letterSpacing: 0.2,
        },
        tabBarStyle: {
          backgroundColor: TAB_BG,
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
          shadowOffset: { width: 0, height: 0 },
          shadowColor: "transparent",
        },
      }}
    >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="house.fill" color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color }) => (
              <IconSymbol size={28} name="gearshape.fill" color={color} />
            ),
          }}
        />
    </Tabs>
  );
}
