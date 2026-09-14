import type { ReactNode } from "react";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";

import { getCategoryDef, isRentalCatalogCategory } from "@/lib/businessCategories";
import { auth } from "@/firebase";
import { ENTITY_IMAGE_LIMITS } from "@/lib/entityImageConfig";
import type { EmilyBrainFormState, EmilyTone, ItemFormEntry } from "@/lib/emilyBrainProfile";
import { newEmilyBrainRowId } from "@/lib/emilyBrainProfile";
import { pickAndUploadEntityImages } from "@/services/entityImageUpload";

const CARD = {
  backgroundColor: "#FFFFFF",
  borderWidth: 1,
  borderColor: "#EEEEEE",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
} as const;

type SectionCardProps = {
  children: ReactNode;
};

export function SectionCard({ children }: SectionCardProps) {
  return <View style={styles.sectionCard}>{children}</View>;
}

type Props = {
  form: EmilyBrainFormState;
  setForm: React.Dispatch<React.SetStateAction<EmilyBrainFormState | null>>;
  saving: boolean;
  /** itemId -> error message for rows the user started filling in but left unnamed. */
  itemNameErrors?: Record<string, string>;
};

const TONE_OPTIONS: { value: EmilyTone; label: string }[] = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "salesy", label: "Salesy" },
];

const CONDITION_OPTIONS = ["New", "Used", "Good condition", "Slightly used", "Low mileage"] as const;
const CONDITION_NOTE_OPTIONS = ["Well maintained", "Neat interior", "Recently serviced"] as const;

function suggestionChipLabel(s: string): string {
  return s.length > 28 ? `${s.slice(0, 26)}…` : s;
}

export function StructuredBusinessSections({
  form,
  setForm,
  saving,
  itemNameErrors,
}: Props) {
  const disabled = saving;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [imageBusyItemId, setImageBusyItemId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => new Set());
  const [customConditionItemIds, setCustomConditionItemIds] = useState<Set<string>>(() => new Set());
  const [customConditionNoteItemIds, setCustomConditionNoteItemIds] = useState<Set<string>>(
    () => new Set()
  );
  const def = getCategoryDef(form.categoryId);
  const L = def.labels;
  const rentalCatalog = isRentalCatalogCategory(form.categoryId);

  const updateService = (id: string, text: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        services: prev.services.map((row) =>
          row.id === id ? { ...row, value: text, source: "user" } : row
        ),
      };
    });
  };

  const addService = () => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            services: [
              ...prev.services,
              { id: newEmilyBrainRowId(), value: "", source: "user" },
            ],
          }
        : prev
    );
  };

  const removeService = (id: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = prev.services.filter((s) => s.id !== id);
      return {
        ...prev,
        services:
          next.length > 0
            ? next
            : [{ id: newEmilyBrainRowId(), value: "", source: "user" }],
      };
    });
  };

  const addServiceSuggestion = (s: string) => {
    const t = s.trim();
    if (!t) return;
    setForm((prev) => {
      if (!prev) return prev;
      const existing = prev.services
        .map((x) => x.value.trim())
        .filter(Boolean);
      if (existing.some((e) => e.toLowerCase() === t.toLowerCase())) return prev;
      const next = [...prev.services];
      const emptyIdx = next.findIndex((x) => !x.value.trim());
      if (emptyIdx >= 0) {
        next[emptyIdx] = {
          ...next[emptyIdx],
          value: t,
          source: "suggestion",
        };
        return { ...prev, services: next };
      }
      return {
        ...prev,
        services: [
          ...next,
          { id: newEmilyBrainRowId(), value: t, source: "suggestion" },
        ],
      };
    });
  };

  const removeItemImageAt = (itemId: string, index: number) => {
    setForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((v) =>
          v.id === itemId
            ? {
                ...v,
                source: "user",
                images: (v.images ?? []).filter((_, i) => i !== index),
              }
            : v
        ),
      };
    });
  };

  const handleAddPhotosForItem = async (itemId: string) => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      Alert.alert("Photos", "Sign in to upload images.");
      return;
    }
    const item = form.items.find((i) => i.id === itemId);
    if (!item) return;
    const current = item.images ?? [];
    if (current.length >= ENTITY_IMAGE_LIMITS.maxPerItem) return;

    setImageBusyItemId(itemId);
    try {
      const newUrls = await pickAndUploadEntityImages({
        userId: uid,
        itemId,
        currentUrls: current,
      });
      if (newUrls.length === 0) return;
      setForm((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((v) =>
            v.id === itemId
              ? {
                  ...v,
                  source: "user",
                  images: [...(v.images ?? []), ...newUrls].slice(
                    0,
                    ENTITY_IMAGE_LIMITS.maxPerItem
                  ),
                }
              : v
          ),
        };
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Could not add photos.";
      Alert.alert("Photos", msg);
    } finally {
      setImageBusyItemId(null);
    }
  };

  const updateItem = (
    id: string,
    field: keyof Pick<
      ItemFormEntry,
      "name" | "color" | "condition" | "conditionNote" | "pricingDaily" | "pricingMonthly"
    >,
    text: string
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((v) =>
          v.id === id ? { ...v, [field]: text, source: "user" } : v
        ),
      };
    });
  };

  const updateLogistics = (
    field:
      | "logisticsDefaultPickupLocation"
      | "logisticsPickupInstructions"
      | "logisticsPickupAvailableHours"
      | "logisticsDeliveryCoverageAreas"
      | "logisticsDeliveryChargesNote",
    text: string
  ) => {
    setForm((prev) => (prev ? { ...prev, [field]: text } : prev));
  };

  const addItem = () => {
    const id = newEmilyBrainRowId();
    setExpandedItemIds((prev) => new Set([...prev, id]));
    setForm((prev) =>
      prev
        ? {
            ...prev,
            items: [
              ...prev.items,
              {
                id,
                name: "",
                color: "",
                condition: "",
                conditionNote: "",
                pricingDaily: "",
                pricingMonthly: "",
                images: [],
                source: "user",
              },
            ],
          }
        : prev
    );
  };

  const removeItem = (id: string) => {
    setExpandedItemIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setCustomConditionItemIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setCustomConditionNoteItemIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setForm((prev) => {
      if (!prev) return prev;
      const next = prev.items.filter((v) => v.id !== id);
      return {
        ...prev,
        items:
          next.length > 0
            ? next
            : [
                {
                  id: newEmilyBrainRowId(),
                  name: "",
                  color: "",
                  condition: "",
                  conditionNote: "",
                  pricingDaily: "",
                  pricingMonthly: "",
                  images: [],
                  source: "user",
                },
              ],
      };
    });
  };

  const addItemSuggestion = (ex: { name: string; color?: string }) => {
    const n = ex.name.trim();
    if (!n) return;
    setForm((prev) => {
      if (!prev) return prev;
      const c = (ex.color ?? "").trim();
      const empty = prev.items.find((it) => !it.name.trim());
      if (empty) {
        return {
          ...prev,
          items: prev.items.map((it) =>
            it.id === empty.id
              ? {
                  ...it,
                  name: n,
                  color: c,
        condition: "",
        conditionNote: "",
                  pricingDaily: "",
                  pricingMonthly: "",
                  images: [],
                  source: "suggestion",
                }
              : it
          ),
        };
      }
      return {
        ...prev,
        items: [
          ...prev.items,
          {
            id: newEmilyBrainRowId(),
            name: n,
            color: c,
            condition: "",
            conditionNote: "",
            pricingDaily: "",
            pricingMonthly: "",
            images: [],
            source: "suggestion",
          },
        ],
      };
    });
  };

  const toggleItemExpanded = (itemId: string) => {
    setExpandedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  const itemSummary = (item: ItemFormEntry) => {
    const parts = [
      item.color.trim(),
      item.pricingDaily.trim() ? `${item.pricingDaily.trim()}/day` : "",
      item.condition.trim(),
    ].filter(Boolean);
    return parts.join(" · ");
  };

  const conditionChipValue = (itemId: string, condition: string) => {
    if (customConditionItemIds.has(itemId)) return "Custom";
    const value = condition.trim();
    if (!value) return "";
    return CONDITION_OPTIONS.some((opt) => opt === value) ? value : "Custom";
  };

  const conditionNoteChipValue = (itemId: string, conditionNote: string) => {
    if (customConditionNoteItemIds.has(itemId)) return "Custom note";
    const value = conditionNote.trim();
    if (!value) return "No note";
    return CONDITION_NOTE_OPTIONS.some((opt) => opt === value) ? value : "Custom note";
  };

  const selectCondition = (itemId: string, value: string) => {
    if (value === "Custom") {
      setCustomConditionItemIds((prev) => new Set([...prev, itemId]));
      const current = form.items.find((item) => item.id === itemId)?.condition.trim() ?? "";
      if (!current || CONDITION_OPTIONS.some((opt) => opt === current)) {
        updateItem(itemId, "condition", "");
      }
      return;
    }
    setCustomConditionItemIds((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
    updateItem(itemId, "condition", value);
  };

  const selectConditionNote = (itemId: string, value: string) => {
    setCustomConditionNoteItemIds((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
    if (value === "No note") {
      updateItem(itemId, "conditionNote", "");
      return;
    }
    if (value === "Custom note") {
      setCustomConditionNoteItemIds((prev) => new Set([...prev, itemId]));
      const current = form.items.find((item) => item.id === itemId)?.conditionNote.trim() ?? "";
      if (!current || CONDITION_NOTE_OPTIONS.some((opt) => opt === current)) {
        updateItem(itemId, "conditionNote", "");
      }
      return;
    }
    updateItem(itemId, "conditionNote", value);
  };

  return (
    <>
      <SectionCard>
        <Text style={styles.sectionTitle}>{L.servicesSectionTitle}</Text>
        <Text style={styles.sectionHint}>{L.servicesHint}</Text>
        {def.serviceSuggestions.length > 0 ? (
          <Text style={styles.suggestionsLabel}>Suggestions</Text>
        ) : null}
        {def.serviceSuggestions.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {def.serviceSuggestions.map((s) => (
              <Pressable
                key={s}
                onPress={() => addServiceSuggestion(s)}
                disabled={disabled}
                style={({ pressed }) => [styles.suggestionChip, pressed && styles.suggestionChipPressed]}
              >
                <Text style={styles.suggestionChipText}>{suggestionChipLabel(s)}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {form.services.map((line) => (
          <View key={line.id} style={styles.rowItem}>
            <TextInput
              style={[styles.input, styles.inputFlex, styles.inputInRow]}
              placeholder={L.servicePlaceholder}
              placeholderTextColor="#94A3B8"
              value={line.value}
              onChangeText={(t) => updateService(line.id, t)}
              editable={!disabled}
            />
            {form.services.length > 1 ? (
              <Pressable
                onPress={() => removeService(line.id)}
                disabled={disabled}
                style={styles.removeBtn}
                accessibilityLabel="Remove service"
              >
                <Text style={styles.removeBtnText}>✕</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        <Pressable
          onPress={addService}
          disabled={disabled}
          style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
        >
          <Text style={styles.addBtnText}>+ Add service</Text>
        </Pressable>
      </SectionCard>

      <SectionCard>
        <Text style={styles.sectionTitle}>{L.itemsSectionTitle}</Text>
        <Text style={styles.sectionHint}>{L.itemsHint}</Text>
        {def.itemSuggestions.length > 0 ? (
          <Text style={styles.suggestionsLabel}>Suggestions</Text>
        ) : null}
        {def.itemSuggestions.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {def.itemSuggestions.map((ex, i) => (
              <Pressable
                key={`${ex.name}-${i}`}
                onPress={() => addItemSuggestion(ex)}
                disabled={disabled}
                style={({ pressed }) => [styles.suggestionChip, pressed && styles.suggestionChipPressed]}
              >
                <Text style={styles.suggestionChipText}>
                  {suggestionChipLabel(ex.color ? `${ex.name} · ${ex.color}` : ex.name)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        {form.items.map((v) => {
          const expanded = expandedItemIds.has(v.id) || !v.name.trim();
          const summary = itemSummary(v);
          const selectedCondition = conditionChipValue(v.id, v.condition);
          const selectedConditionNote = conditionNoteChipValue(v.id, v.conditionNote);
          return (
            <View key={v.id} style={styles.itemBlock}>
              <View style={styles.itemHeaderRow}>
                <Pressable
                  onPress={() => toggleItemExpanded(v.id)}
                  disabled={disabled}
                  style={({ pressed }) => [
                    styles.itemHeaderMain,
                    pressed && styles.itemHeaderPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={expanded ? "Collapse item editor" : "Expand item editor"}
                >
                  <Text style={styles.itemHeaderTitle}>
                    {v.name.trim() || L.itemNamePlaceholder}
                  </Text>
                  {summary ? <Text style={styles.itemHeaderSummary}>{summary}</Text> : null}
                </Pressable>
                {form.items.length > 1 ? (
                  <Pressable
                    onPress={() => removeItem(v.id)}
                    disabled={disabled}
                    style={styles.removeBtn}
                    accessibilityLabel="Remove item"
                  >
                    <Text style={styles.removeBtnText}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
              {expanded ? (
                <>
                  <TextInput
                    style={[
                      styles.input,
                      itemNameErrors?.[v.id] && styles.inputInvalid,
                    ]}
                    placeholder={L.itemNamePlaceholder}
                    placeholderTextColor="#94A3B8"
                    value={v.name}
                    onChangeText={(t) => updateItem(v.id, "name", t)}
                    editable={!disabled}
                  />
                  {itemNameErrors?.[v.id] ? (
                    <Text style={styles.inlineFieldError}>{itemNameErrors[v.id]}</Text>
                  ) : null}
                  <TextInput
                    style={[styles.input, styles.inputStacked]}
                    placeholder={L.itemDetailPlaceholder}
                    placeholderTextColor="#94A3B8"
                    value={v.color}
                    onChangeText={(t) => updateItem(v.id, "color", t)}
                    editable={!disabled}
                  />
                  <View style={styles.conditionSection}>
                    <Text style={styles.itemPricingFieldLabel}>Condition</Text>
                    <View style={styles.selectChipWrap}>
                      {[...CONDITION_OPTIONS, "Custom"].map((option) => {
                        const selected = selectedCondition === option;
                        return (
                          <Pressable
                            key={option}
                            onPress={() => selectCondition(v.id, option)}
                            disabled={disabled}
                            style={({ pressed }) => [
                              styles.selectChip,
                              selected && styles.selectChipSelected,
                              pressed && styles.selectChipPressed,
                            ]}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                          >
                            <Text
                              style={[
                                styles.selectChipText,
                                selected && styles.selectChipTextSelected,
                              ]}
                            >
                              {option}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {selectedCondition === "Custom" ? (
                      <TextInput
                        style={[styles.input, styles.inputStacked]}
                        placeholder="Custom condition"
                        placeholderTextColor="#94A3B8"
                        value={v.condition}
                        onChangeText={(t) => updateItem(v.id, "condition", t)}
                        editable={!disabled}
                      />
                    ) : null}
                  </View>
                  <View style={styles.conditionSection}>
                    <Text style={styles.itemPricingFieldLabel}>Condition note</Text>
                    <View style={styles.selectChipWrap}>
                      {["No note", ...CONDITION_NOTE_OPTIONS, "Custom note"].map((option) => {
                        const selected = selectedConditionNote === option;
                        return (
                          <Pressable
                            key={option}
                            onPress={() => selectConditionNote(v.id, option)}
                            disabled={disabled}
                            style={({ pressed }) => [
                              styles.selectChip,
                              selected && styles.selectChipSelected,
                              pressed && styles.selectChipPressed,
                            ]}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                          >
                            <Text
                              style={[
                                styles.selectChipText,
                                selected && styles.selectChipTextSelected,
                              ]}
                            >
                              {option}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {selectedConditionNote === "Custom note" ? (
                      <TextInput
                        style={[styles.input, styles.textAreaSmall, styles.inputStacked]}
                        placeholder="Custom condition note"
                        placeholderTextColor="#94A3B8"
                        value={v.conditionNote}
                        onChangeText={(t) => updateItem(v.id, "conditionNote", t)}
                        multiline
                        textAlignVertical="top"
                        editable={!disabled}
                      />
                    ) : null}
                  </View>
                  <Text style={styles.itemPricingLabel}>
                    {rentalCatalog
                      ? "Vehicle rent (PKR, optional)"
                      : "Item pricing (PKR, optional)"}
                  </Text>
                  <View style={styles.itemPricingRow}>
                    <View style={[styles.itemPricingField, styles.itemPricingFieldSpacing]}>
                      <Text style={styles.itemPricingFieldLabel}>
                        {rentalCatalog ? "Per day rent" : "Per day Price"}
                      </Text>
                      <TextInput
                        style={styles.input}
                        placeholder="—"
                        placeholderTextColor="#94A3B8"
                        keyboardType="decimal-pad"
                        value={v.pricingDaily}
                        onChangeText={(t) => updateItem(v.id, "pricingDaily", t)}
                        editable={!disabled}
                      />
                    </View>
                    <View style={styles.itemPricingField}>
                      <Text style={styles.itemPricingFieldLabel}>
                        {rentalCatalog ? "Per month rent" : "Monthly Price"}
                      </Text>
                      <TextInput
                        style={styles.input}
                        placeholder="—"
                        placeholderTextColor="#94A3B8"
                        keyboardType="decimal-pad"
                        value={v.pricingMonthly}
                        onChangeText={(t) => updateItem(v.id, "pricingMonthly", t)}
                        editable={!disabled}
                      />
                    </View>
                  </View>

                  <View style={styles.imagesSection}>
              <Text style={styles.imagesSectionLabel}>
                Photos (optional){" "}
                <Text style={styles.imagesCount}>
                  ({(v.images ?? []).length}/{ENTITY_IMAGE_LIMITS.maxPerItem})
                </Text>
              </Text>
              <Text style={styles.imagesHint}>
                Add photos so Emily can share them with customers on WhatsApp. You can add
                these later.
              </Text>
              <View style={styles.thumbGrid}>
                {(v.images ?? []).map((uri, idx) => (
                  <View key={`${v.id}-img-${idx}`} style={styles.thumbWrap}>
                    {/**
                     * Use RN `Image`, not `expo-image`, for remote HTTPS previews on iOS/Android.
                     * `whatwg-fetch` + `Response.blob()` uses `new Blob([ArrayBuffer])`, which
                     * triggers RN BlobManager: "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported".
                     */}
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => setPreviewImage(uri)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel="View full size image"
                    >
                      <Image
                        source={{ uri }}
                        style={styles.thumbImage}
                        resizeMode="cover"
                      />
                    </TouchableOpacity>
                    <Pressable
                      style={styles.thumbRemove}
                      onPress={() => removeItemImageAt(v.id, idx)}
                      disabled={disabled || imageBusyItemId !== null}
                      accessibilityLabel="Remove image"
                    >
                      <Text style={styles.thumbRemoveText}>✕</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.addPhotosBtn,
                  ((v.images ?? []).length >= ENTITY_IMAGE_LIMITS.maxPerItem ||
                    disabled ||
                    imageBusyItemId !== null) &&
                    styles.addPhotosBtnDisabled,
                  pressed &&
                    (v.images ?? []).length < ENTITY_IMAGE_LIMITS.maxPerItem &&
                    !disabled &&
                    imageBusyItemId === null &&
                    styles.addPhotosBtnPressed,
                ]}
                disabled={
                  disabled ||
                  imageBusyItemId !== null ||
                  (v.images ?? []).length >= ENTITY_IMAGE_LIMITS.maxPerItem
                }
                onPress={() => {
                  void handleAddPhotosForItem(v.id);
                }}
              >
                {imageBusyItemId === v.id ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <Text style={styles.addPhotosBtnText}>+ Add Photos</Text>
                )}
              </Pressable>
                  </View>
                </>
              ) : null}
            </View>
          );
        })}
        <Pressable
          onPress={addItem}
          disabled={disabled}
          style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]}
        >
          <Text style={styles.addBtnText}>{L.addItemLabel}</Text>
        </Pressable>
      </SectionCard>

      {!rentalCatalog ? (
        <SectionCard>
          <Text style={styles.sectionTitle}>Default prices (global)</Text>
          <Text style={styles.sectionHint}>
            Used when an item above has no daily or monthly price set. Per-item prices override
            these for that item.
          </Text>
          <View style={styles.field}>
            <Text style={styles.label}>Per day Price</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              placeholderTextColor="#94A3B8"
              keyboardType="decimal-pad"
              value={form.pricingDaily}
              onChangeText={(t) =>
                setForm((prev) => (prev ? { ...prev, pricingDaily: t } : prev))
              }
              editable={!disabled}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>Monthly Price</Text>
            <TextInput
              style={styles.input}
              placeholder="0"
              placeholderTextColor="#94A3B8"
              keyboardType="decimal-pad"
              value={form.pricingMonthly}
              onChangeText={(t) =>
                setForm((prev) => (prev ? { ...prev, pricingMonthly: t } : prev))
              }
              editable={!disabled}
            />
          </View>
          <Text style={styles.currencyTag}>PKR</Text>
        </SectionCard>
      ) : null}

      <SectionCard>
        <Text style={styles.sectionTitle}>Pickup & Delivery Details</Text>
        <Text style={styles.sectionHint}>
          Optional verified details Emily can use when customers ask pickup or delivery questions.
        </Text>
        <View style={styles.field}>
          <Text style={styles.label}>Pickup location</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Bahria Phase 7 office"
            placeholderTextColor="#94A3B8"
            value={form.logisticsDefaultPickupLocation}
            onChangeText={(t) => updateLogistics("logisticsDefaultPickupLocation", t)}
            editable={!disabled}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Pickup instructions</Text>
          <TextInput
            style={[styles.input, styles.textAreaSmall]}
            placeholder="e.g. Call before arrival, bring CNIC"
            placeholderTextColor="#94A3B8"
            value={form.logisticsPickupInstructions}
            onChangeText={(t) => updateLogistics("logisticsPickupInstructions", t)}
            multiline
            textAlignVertical="top"
            editable={!disabled}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Pickup available timings</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 10am-8pm"
            placeholderTextColor="#94A3B8"
            value={form.logisticsPickupAvailableHours}
            onChangeText={(t) => updateLogistics("logisticsPickupAvailableHours", t)}
            editable={!disabled}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Delivery areas</Text>
          <TextInput
            style={[styles.input, styles.textAreaSmall]}
            placeholder="e.g. DHA, Bahria Town, Islamabad"
            placeholderTextColor="#94A3B8"
            value={form.logisticsDeliveryCoverageAreas}
            onChangeText={(t) => updateLogistics("logisticsDeliveryCoverageAreas", t)}
            multiline
            textAlignVertical="top"
            editable={!disabled}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Delivery charges note</Text>
          <TextInput
            style={[styles.input, styles.textAreaSmall]}
            placeholder="e.g. Charges depend on area"
            placeholderTextColor="#94A3B8"
            value={form.logisticsDeliveryChargesNote}
            onChangeText={(t) => updateLogistics("logisticsDeliveryChargesNote", t)}
            multiline
            textAlignVertical="top"
            editable={!disabled}
          />
        </View>
      </SectionCard>

      <SectionCard>
        <Text style={styles.sectionTitle}>How should Emily talk?</Text>
        <Text style={styles.sectionHint}>Tone for customer chats</Text>
        {TONE_OPTIONS.map((opt) => {
          const selected = form.tone === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() =>
                setForm((prev) => (prev ? { ...prev, tone: opt.value } : prev))
              }
              disabled={disabled}
              style={({ pressed }) => [
                styles.radioRow,
                selected && styles.radioRowSelected,
                pressed && styles.radioRowPressed,
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <View style={[styles.radioOuter, selected && styles.radioOuterSelected]}>
                {selected ? <View style={styles.radioInner} /> : null}
              </View>
              <Text style={styles.radioLabel}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </SectionCard>

      <SectionCard>
        <Text style={styles.sectionTitle}>Anything Emily should always remember?</Text>
        <Text style={styles.sectionHint}>Optional — special rules or reminders</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder='e.g. Always ask pickup location before confirming booking'
          placeholderTextColor="#94A3B8"
          value={form.instructions}
          onChangeText={(t) =>
            setForm((prev) => (prev ? { ...prev, instructions: t } : prev))
          }
          multiline
          textAlignVertical="top"
          numberOfLines={4}
          editable={!disabled}
        />
      </SectionCard>

      <Modal
        visible={!!previewImage}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewImage(null)}
      >
        <View style={styles.imagePreviewRoot}>
          {/**
           * Backdrop must stay zIndex 0. Image layer uses zIndex 1 + absoluteFill so it paints
           * above the dismiss target (fixes blank preview on some Android / Modal layouts).
           */}
          <Pressable
            style={[StyleSheet.absoluteFillObject, styles.imagePreviewBackdropHit]}
            onPress={() => setPreviewImage(null)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss image preview"
          />
          <View
            style={[StyleSheet.absoluteFillObject, styles.imagePreviewImageWrap]}
            pointerEvents="box-none"
          >
            {previewImage ? (
              <View
                style={[
                  styles.imagePreviewImageClip,
                  {
                    width: Math.round(windowWidth * 0.9),
                    height: Math.round(windowHeight * 0.7),
                  },
                ]}
              >
                <Pressable
                  onPress={() => {}}
                  style={styles.imagePreviewImageInner}
                  accessibilityRole="image"
                  accessibilityLabel="Preview image"
                >
                  <Image
                    source={{ uri: previewImage }}
                    style={StyleSheet.absoluteFillObject}
                    resizeMode="contain"
                  />
                </Pressable>
              </View>
            ) : null}
          </View>
          <TouchableOpacity
            style={styles.imagePreviewCloseBtn}
            onPress={() => setPreviewImage(null)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Close image preview"
          >
            <Text style={styles.imagePreviewCloseIcon}>✕</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sectionCard: {
    ...CARD,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111111",
    marginBottom: 4,
  },
  sectionHint: {
    fontSize: 13,
    color: "#64748B",
    marginBottom: 12,
    lineHeight: 18,
  },
  suggestionsLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#94A3B8",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "nowrap",
    paddingBottom: 12,
    alignItems: "center",
  },
  suggestionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "#FAFAFA",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    marginRight: 8,
  },
  suggestionChipPressed: {
    opacity: 0.8,
  },
  suggestionChipText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#475569",
  },
  field: {
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: "500",
    color: "#334155",
    marginBottom: 6,
  },
  input: {
    backgroundColor: "#FAFAFA",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "ios" ? 12 : 10,
    fontSize: 16,
    color: "#111111",
  },
  inputFlex: {
    flex: 1,
  },
  inputInRow: {
    marginRight: 8,
  },
  inputStacked: {
    marginTop: 10,
  },
  inputInvalid: {
    borderColor: "#DC2626",
  },
  inlineFieldError: {
    marginTop: 6,
    fontSize: 13,
    color: "#DC2626",
    lineHeight: 18,
  },
  textArea: {
    minHeight: 100,
    paddingTop: 12,
    lineHeight: 22,
  },
  textAreaSmall: {
    minHeight: 76,
    paddingTop: 12,
    lineHeight: 22,
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  itemBlock: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#EEEEEE",
  },
  itemHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
  },
  itemHeaderMain: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: "#FAFAFA",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    marginRight: 8,
  },
  itemHeaderPressed: {
    opacity: 0.85,
  },
  itemHeaderTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111111",
  },
  itemHeaderSummary: {
    marginTop: 3,
    fontSize: 12,
    color: "#64748B",
  },
  conditionSection: {
    marginTop: 12,
  },
  selectChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 2,
    marginBottom: 2,
  },
  selectChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "#FAFAFA",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    marginRight: 8,
    marginBottom: 8,
  },
  selectChipSelected: {
    backgroundColor: "#111111",
    borderColor: "#111111",
  },
  selectChipPressed: {
    opacity: 0.85,
  },
  selectChipText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#475569",
  },
  selectChipTextSelected: {
    color: "#FFFFFF",
  },
  imagesSection: {
    marginTop: 12,
  },
  imagesSectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#334155",
    marginBottom: 4,
  },
  imagesCount: {
    fontWeight: "500",
    color: "#64748B",
  },
  imagesHint: {
    fontSize: 12,
    color: "#64748B",
    lineHeight: 17,
    marginBottom: 8,
  },
  thumbGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 10,
  },
  thumbWrap: {
    width: 76,
    height: 76,
    borderRadius: 10,
    overflow: "hidden",
    marginRight: 8,
    marginBottom: 8,
    backgroundColor: "#F1F5F9",
  },
  thumbImage: {
    width: "100%",
    height: "100%",
  },
  thumbRemove: {
    position: "absolute",
    top: 4,
    right: 4,
    zIndex: 2,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbRemoveText: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "700",
  },
  imagePreviewRoot: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  imagePreviewBackdropHit: {
    zIndex: 0,
  },
  imagePreviewCloseBtn: {
    position: "absolute",
    top: 50,
    right: 20,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  imagePreviewCloseIcon: {
    color: "#FFFFFF",
    fontSize: 20,
    lineHeight: 22,
    fontWeight: "300",
  },
  imagePreviewImageWrap: {
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1,
  },
  /** Clips `contain` image; width/height set in JS from useWindowDimensions (Modal % layout is unreliable). */
  imagePreviewImageClip: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "transparent",
  },
  imagePreviewImageInner: {
    width: "100%",
    height: "100%",
  },
  addPhotosBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#111111",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    minWidth: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  addPhotosBtnDisabled: {
    opacity: 0.45,
  },
  addPhotosBtnPressed: {
    opacity: 0.88,
  },
  addPhotosBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  itemPricingLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#64748B",
    marginTop: 4,
    marginBottom: 8,
  },
  itemPricingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  itemPricingField: {
    flex: 1,
    minWidth: 0,
  },
  itemPricingFieldSpacing: {
    marginRight: 10,
  },
  itemPricingFieldLabel: {
    fontSize: 12,
    fontWeight: "500",
    color: "#64748B",
    marginBottom: 6,
  },
  removeBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  removeBtnText: {
    fontSize: 18,
    color: "#94A3B8",
  },
  addBtn: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  addBtnPressed: {
    opacity: 0.7,
  },
  addBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111111",
  },
  currencyTag: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: "600",
    color: "#64748B",
  },
  radioRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderRadius: 10,
    marginBottom: 4,
  },
  radioRowSelected: {
    backgroundColor: "rgba(17, 17, 17, 0.04)",
  },
  radioRowPressed: {
    opacity: 0.85,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#CBD5E1",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  radioOuterSelected: {
    borderColor: "#111111",
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#111111",
  },
  radioLabel: {
    fontSize: 16,
    color: "#111111",
    fontWeight: "500",
  },
});
