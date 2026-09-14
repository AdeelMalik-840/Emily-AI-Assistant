import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type Props = {
  /** Current `form.businessType` value -- source of truth, plain string, no schema change. */
  value: string;
  /** Category-specific subtypes ("Other" is always appended by this component). */
  suggestions: string[];
  disabled?: boolean;
  error?: boolean;
  onSelect: (value: string) => void;
};

const PLACEHOLDER = "Select business type";

/**
 * Suggestions are choices, never defaults -- nothing here auto-selects or
 * auto-fills `value`. Picking "Other" reveals a required free-text field
 * instead of silently assuming a subtype.
 */
export function BusinessTypePicker({ value, suggestions, disabled, error, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [otherMode, setOtherMode] = useState(false);
  const customInputRef = useRef<TextInput>(null);

  // Derive Other-mode from the value itself so this stays correct whether the
  // value came from a suggestion tap, typing, a category switch clearing it,
  // or an existing saved business loading a custom (non-suggestion) type.
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setOtherMode(false);
      return;
    }
    const matchesSuggestion = suggestions.some(
      (s) => s.trim().toLowerCase() === trimmed.toLowerCase()
    );
    setOtherMode(!matchesSuggestion);
  }, [value, suggestions]);

  const close = () => setOpen(false);

  const pickSuggestion = (s: string) => {
    setOtherMode(false);
    onSelect(s);
    setOpen(false);
  };

  const pickOther = () => {
    setOtherMode(true);
    onSelect("");
    setOpen(false);
    setTimeout(() => customInputRef.current?.focus(), 250);
  };

  return (
    <View>
      {otherMode ? (
        <>
          <TextInput
            ref={customInputRef}
            style={[styles.customInput, error && styles.customInputError]}
            placeholder="Enter your business type"
            placeholderTextColor="#94A3B8"
            value={value}
            onChangeText={onSelect}
            autoCapitalize="sentences"
            editable={!disabled}
          />
          {suggestions.length > 0 ? (
            <Pressable
              onPress={() => !disabled && setOpen(true)}
              disabled={disabled}
              hitSlop={8}
              style={styles.switchLinkWrap}
            >
              <Text style={styles.switchLink}>Choose from suggestions instead</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Pressable
          onPress={() => !disabled && setOpen(true)}
          disabled={disabled}
          style={({ pressed }) => [
            styles.trigger,
            error && styles.triggerError,
            disabled && styles.triggerDisabled,
            pressed && !disabled && styles.triggerPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Business type"
          accessibilityHint="Opens list of business type suggestions"
        >
          <Text style={[styles.triggerText, !value && styles.triggerPlaceholder]}>
            {value || PLACEHOLDER}
          </Text>
          <Text style={styles.chevron} importantForAccessibility="no">
            ▼
          </Text>
        </Pressable>
      )}

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}
      >
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Business type</Text>
            <Pressable onPress={close} style={styles.doneBtn} hitSlop={12}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            style={styles.sheetList}
            contentContainerStyle={styles.sheetListContent}
          >
            {suggestions.map((s) => {
              const selected = !otherMode && value.trim().toLowerCase() === s.toLowerCase();
              return (
                <Pressable
                  key={s}
                  onPress={() => pickSuggestion(s)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    selected && styles.optionRowSelected,
                    pressed && styles.optionRowPressed,
                  ]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {s}
                  </Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })}
            <Pressable
              onPress={pickOther}
              style={({ pressed }) => [
                styles.optionRow,
                otherMode && styles.optionRowSelected,
                pressed && styles.optionRowPressed,
              ]}
            >
              <Text style={[styles.optionText, otherMode && styles.optionTextSelected]}>
                Other
              </Text>
              {otherMode ? <Text style={styles.check}>✓</Text> : null}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
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
  triggerError: {
    borderColor: "#DC2626",
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
  customInput: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 16,
    color: "#111111",
  },
  customInputError: {
    borderColor: "#DC2626",
  },
  switchLinkWrap: {
    marginTop: 8,
    alignSelf: "flex-start",
  },
  switchLink: {
    fontSize: 13,
    fontWeight: "600",
    color: "#0369A1",
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
