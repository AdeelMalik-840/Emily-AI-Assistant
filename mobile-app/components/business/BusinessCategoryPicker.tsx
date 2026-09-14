import { useCallback, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  BUSINESS_CATEGORIES,
  BUSINESS_CATEGORY_DROPDOWN_ORDER,
  type BusinessCategoryId,
} from "@/lib/businessCategories";

type Props = {
  value: BusinessCategoryId | undefined;
  onSelect: (id: BusinessCategoryId) => void;
  disabled?: boolean;
};

const PLACEHOLDER = "Select your business category";

export function BusinessCategoryPicker({ value, onSelect, disabled }: Props) {
  const [open, setOpen] = useState(false);

  const label = value ? BUSINESS_CATEGORIES[value].dropdownLabel : null;

  const close = useCallback(() => setOpen(false), []);

  const pick = useCallback(
    (id: BusinessCategoryId) => {
      onSelect(id);
      setOpen(false);
    },
    [onSelect]
  );

  return (
    <>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        style={({ pressed }) => [
          styles.trigger,
          disabled && styles.triggerDisabled,
          pressed && !disabled && styles.triggerPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Business category"
        accessibilityHint="Opens list of business categories"
      >
        <Text style={[styles.triggerText, !label && styles.triggerPlaceholder]}>
          {label ?? PLACEHOLDER}
        </Text>
        <Text style={styles.chevron} importantForAccessibility="no">
          ▼
        </Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Business category</Text>
            <Pressable onPress={close} style={styles.doneBtn} hitSlop={12}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.sheetList}
            contentContainerStyle={styles.sheetListContent}
          >
            {BUSINESS_CATEGORY_DROPDOWN_ORDER.map((id) => {
              const row = BUSINESS_CATEGORIES[id];
              const selected = value === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => pick(id)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    selected && styles.optionRowSelected,
                    pressed && styles.optionRowPressed,
                  ]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {row.dropdownLabel}
                  </Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    minHeight: 48,
  },
  triggerDisabled: {
    opacity: 0.55,
  },
  triggerPressed: {
    opacity: 0.92,
  },
  triggerText: {
    flex: 1,
    fontSize: 16,
    color: "#111111",
    paddingRight: 8,
  },
  triggerPlaceholder: {
    color: "#94A3B8",
  },
  chevron: {
    fontSize: 12,
    color: "#64748B",
  },
  sheet: {
    flex: 1,
    backgroundColor: "#FAFAFA",
    paddingTop: Platform.OS === "ios" ? 8 : 16,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E2E8F0",
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#111111",
  },
  doneBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  doneBtnText: {
    fontSize: 17,
    fontWeight: "600",
    color: "#111111",
  },
  sheetList: {
    flex: 1,
  },
  sheetListContent: {
    paddingVertical: 8,
    paddingBottom: 32,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: "#FFFFFF",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#F1F5F9",
  },
  optionRowSelected: {
    backgroundColor: "rgba(17, 17, 17, 0.04)",
  },
  optionRowPressed: {
    opacity: 0.85,
  },
  optionText: {
    flex: 1,
    fontSize: 16,
    color: "#111111",
    paddingRight: 12,
  },
  optionTextSelected: {
    fontWeight: "600",
  },
  check: {
    fontSize: 18,
    color: "#111111",
    fontWeight: "700",
  },
});
