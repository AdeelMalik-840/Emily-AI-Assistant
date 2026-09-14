import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { doc, serverTimestamp } from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BusinessCategoryPicker } from "@/components/business/BusinessCategoryPicker";
import { BusinessTypePicker } from "@/components/business/BusinessTypePicker";
import { StructuredBusinessSections } from "@/components/business/StructuredBusinessSections";
import { routes } from "@/constants/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { auth, db } from "@/firebase";
import type { BusinessCategoryId } from "@/lib/businessCategories";
import {
  businessTypeDuplicatesCategory,
  getCategoryDef,
  isBusinessCategoryId,
} from "@/lib/businessCategories";
import { validateEntityImagesForSave } from "@/lib/entityImageConfig";
import {
  applyBusinessCategoryChange,
  emptyEmilyBrainForm,
  emilyBrainFormFromDoc,
  formStateToFirestoreBusinessProfile,
  isValidOwnerNotificationPhone,
  type EmilyBrainFormState,
} from "@/lib/emilyBrainProfile";
import {
  SAVE_OPERATION_TIMEOUT_MS,
  getDocWithNetworkRetryResult,
} from "@/utils/firestoreSave";
import { setDocMergeWithRetryOrQueue } from "@/utils/firestoreOfflineQueue";

/**
 * Required-field checks, in form order. `category`/`businessType`/`offerings`
 * only apply once a category is selected -- those sections are hidden until
 * then (progressive disclosure), so validating them earlier would flag a
 * field the user can't even see yet.
 */
type RequiredFieldKey =
  | "businessName"
  | "category"
  | "ownerPhone"
  | "businessType"
  | "offerings";

function validateRequiredFields(
  form: EmilyBrainFormState
): Array<{ field: RequiredFieldKey; message: string }> {
  const errors: Array<{ field: RequiredFieldKey; message: string }> = [];

  if (!form.businessName.trim()) {
    errors.push({ field: "businessName", message: "Enter your business name." });
  }
  if (!form.categoryId) {
    errors.push({ field: "category", message: "Select a business category." });
  }
  if (!isValidOwnerNotificationPhone(form.ownerNotificationPhone)) {
    errors.push({
      field: "ownerPhone",
      message: "Enter the WhatsApp number Emily should use for owner notifications.",
    });
  }

  if (form.categoryId) {
    const type = form.businessType.trim();
    if (!type) {
      errors.push({
        field: "businessType",
        message: "Select your business type.",
      });
    } else if (businessTypeDuplicatesCategory(form.categoryId, type)) {
      const def = getCategoryDef(form.categoryId);
      const example = def.businessTypeSuggestions[0];
      errors.push({
        field: "businessType",
        message: `Business type should be more specific than “${def.dropdownLabel}”${example ? ` — e.g. “${example}”` : ""}.`,
      });
    }

    const hasValidService = form.services.some((s) => s.value.trim());
    const hasValidItem = form.items.some((it) => it.name.trim());
    if (!hasValidService && !hasValidItem) {
      errors.push({
        field: "offerings",
        message: "Add at least one service or offering so Emily knows what your business provides.",
      });
    }
  }

  return errors;
}

/**
 * Any item row the user has started filling in (color/condition/price/photo)
 * must have a name before save, even if another row already satisfies the
 * "at least one offering" rule above. Only meaningful once a category is
 * selected -- the items section is hidden before that.
 */
function validateItemStartedWithoutName(
  form: EmilyBrainFormState
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of form.items) {
    if (it.name.trim()) continue;
    const started =
      it.color.trim() !== "" ||
      it.condition.trim() !== "" ||
      it.conditionNote.trim() !== "" ||
      it.pricingDaily.trim() !== "" ||
      it.pricingMonthly.trim() !== "" ||
      (it.images?.length ?? 0) > 0;
    if (started) {
      out[it.id] = "Enter a name for this offering.";
    }
  }
  return out;
}

export default function BusinessSetupScreen() {
  const { user, loading } = useAuth();
  const userId = user?.uid;
  const [form, setForm] = useState<EmilyBrainFormState | null>(null);
  /** Matches `checkBusinessProfile`: doc exists with `businessName` or `business_name`. */
  const [hasExistingBusiness, setHasExistingBusiness] = useState(false);
  const [profileLoading, setProfileLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [categorySwitchHint, setCategorySwitchHint] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RequiredFieldKey, string>>>({});
  const [itemNameErrors, setItemNameErrors] = useState<Record<string, string>>({});
  const [validationBanner, setValidationBanner] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const formRef = useRef<EmilyBrainFormState | null>(null);
  formRef.current = form;
  const scrollRef = useRef<ScrollView>(null);
  const businessNameInputRef = useRef<TextInput>(null);
  const ownerPhoneInputRef = useRef<TextInput>(null);
  /** y-offset of each required field's wrapping View within the ScrollView content, captured via onLayout. */
  const fieldOffsetsRef = useRef<Partial<Record<RequiredFieldKey, number>>>({});
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    };
  }, []);

  // Auto-clear an error the moment its underlying value becomes valid again,
  // so the user never has to re-tap Save just to see an error disappear.
  useEffect(() => {
    if (!form) return;
    setFieldErrors((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      if (next.businessName && form.businessName.trim()) {
        delete next.businessName;
        changed = true;
      }
      if (next.category && form.categoryId) {
        delete next.category;
        changed = true;
      }
      if (next.ownerPhone && isValidOwnerNotificationPhone(form.ownerNotificationPhone)) {
        delete next.ownerPhone;
        changed = true;
      }
      if (next.businessType) {
        const type = form.businessType.trim();
        if (type && form.categoryId && !businessTypeDuplicatesCategory(form.categoryId, type)) {
          delete next.businessType;
          changed = true;
        }
      }
      if (next.offerings) {
        const hasValidService = form.services.some((s) => s.value.trim());
        const hasValidItem = form.items.some((it) => it.name.trim());
        if (hasValidService || hasValidItem) {
          delete next.offerings;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setItemNameErrors((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      let changed = false;
      const next: Record<string, string> = {};
      for (const [id, message] of Object.entries(prev)) {
        const item = form.items.find((it) => it.id === id);
        if (!item || item.name.trim()) {
          changed = true;
          continue;
        }
        next[id] = message;
      }
      return changed ? next : prev;
    });
  }, [form]);

  const showValidationBanner = useCallback((count: number) => {
    if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    setValidationBanner(
      count > 1 ? `${count} fields need your attention.` : "Please complete the highlighted field."
    );
    bannerTimeoutRef.current = setTimeout(() => setValidationBanner(null), 3000);
  }, []);

  // "category" and "businessType" are custom picker controls (no keyboard-
  // focusable TextInput to jump to) -- they're scroll-only, same as before.
  const fieldInputRefs: Partial<Record<RequiredFieldKey, React.RefObject<TextInput | null>>> = {
    businessName: businessNameInputRef,
    ownerPhone: ownerPhoneInputRef,
  };

  const scrollToField = useCallback((field: RequiredFieldKey) => {
    const y = fieldOffsetsRef.current[field];
    if (typeof y === "number") {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
    }
    setTimeout(() => fieldInputRefs[field]?.current?.focus(), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading) return;

    if (!userId) {
      setForm(null);
      setHasExistingBusiness(false);
      setProfileLoading(false);
      return;
    }

    let cancelled = false;
    setProfileLoading(true);

    void (async () => {
      const ref = doc(db, "businesses", userId);
      try {
        const result = await getDocWithNetworkRetryResult(db, ref);
        const docSnap = result.data;
        if (cancelled) return;

        if (!docSnap?.exists()) {
          setHasExistingBusiness(false);
          setForm(emptyEmilyBrainForm());
          return;
        }

        const raw = docSnap.data() as Record<string, unknown>;
        setHasExistingBusiness(
          Boolean(raw?.businessName ?? raw?.business_name)
        );
        const next = emilyBrainFormFromDoc(raw);
        setForm(next);
      } catch (e) {
        console.error("[BusinessSetup] load business profile failed:", e);
        if (!cancelled) {
          setHasExistingBusiness(false);
          setForm(emptyEmilyBrainForm());
        }
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, loading]);

  const handleSave = useCallback(async () => {
    if (saveInFlightRef.current || !form) return;

    const requiredErrors = validateRequiredFields(form);
    const startedItemErrors = form.categoryId ? validateItemStartedWithoutName(form) : {};
    const hasItemErrors = Object.keys(startedItemErrors).length > 0;

    if (requiredErrors.length > 0 || hasItemErrors) {
      const nextFieldErrors: Partial<Record<RequiredFieldKey, string>> = {};
      for (const { field, message } of requiredErrors) {
        nextFieldErrors[field] = message;
      }
      setFieldErrors(nextFieldErrors);
      setItemNameErrors(startedItemErrors);

      showValidationBanner(requiredErrors.length + (hasItemErrors ? 1 : 0));

      const firstField = requiredErrors[0]?.field ?? (hasItemErrors ? "offerings" : undefined);
      if (firstField) scrollToField(firstField);
      return;
    }
    setFieldErrors({});
    setItemNameErrors({});

    const imageValidationError = validateEntityImagesForSave(form);
    if (imageValidationError) {
      setSaveError(imageValidationError);
      return;
    }

    const u = auth.currentUser;
    if (!u?.uid || !u.email) {
      setSaveError("User not authenticated. Please sign in with your email.");
      return;
    }

    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const uid = u.uid;
      const ref = doc(db, "businesses", uid);
      const businessProfile = formStateToFirestoreBusinessProfile(form);
      if (businessProfile.ownerNotificationPhone) {
        console.log(
          "📦 Saving ownerNotificationPhone in businessProfile:",
          businessProfile.ownerNotificationPhone
        );
      }

      const plain = {
        userId: uid,
        businessName: businessProfile.name,
        businessType: businessProfile.type,
        businessKnowledge: "",
        tone: businessProfile.tone,
        businessProfile,
      };

      const writeResult = await Promise.race([
        setDocMergeWithRetryOrQueue(
          db,
          ref,
          { ...plain, updatedAt: serverTimestamp() },
          plain
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Save timed out after ${SAVE_OPERATION_TIMEOUT_MS / 1000}s. Check your connection.`
                )
              ),
            SAVE_OPERATION_TIMEOUT_MS
          )
        ),
      ]);

      console.log("✅ [BusinessSetup] Emily Brain profile saved", businessProfile);
      setCategorySwitchHint(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const isSetup = !hasExistingBusiness;
      if (isSetup) {
        router.replace(routes.tabs);
        return;
      }

      setSaveSuccess(
        writeResult.status === "queued"
          ? "Saved offline, will sync automatically"
          : "Your business info saved."
      );
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      console.log("[BusinessSetup] SAVE ERROR:", err.code, err.message);
      console.error("[BusinessSetup] Firestore save failed:", e);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setSaveError("Failed to save. Please try again.");
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;
    }
  }, [form, hasExistingBusiness, scrollToField, showValidationBanner]);

  const handleCategorySelect = useCallback((id: BusinessCategoryId) => {
    const prev = formRef.current;
    if (!prev || prev.categoryId === id) return;

    const isSwitch =
      prev.categoryId != null &&
      String(prev.categoryId).trim() !== "" &&
      isBusinessCategoryId(String(prev.categoryId));

    if (isSwitch) {
      const title = "Change business category?";
      const message =
        "Changing business category will reset your current services and items so they match the new type. Your business name, pricing, tone, and instructions stay the same.";
      const applySwitch = () => {
        setForm((p) => {
          const base = p ?? formRef.current;
          return base ? applyBusinessCategoryChange(base, id) : base;
        });
        setCategorySwitchHint(
          "Services and items were reset for this category. Add your offerings below."
        );
      };

      // react-native-web's Alert.alert() is a no-op (see node_modules/
      // react-native-web/dist/exports/Alert/index.js: `static alert() {}`),
      // so this confirmation would silently never appear -- and the category
      // could never actually be switched -- on web without this branch.
      // window.confirm() is the web-safe equivalent; native keeps the
      // existing Alert.alert() dialog unchanged.
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
          applySwitch();
        }
        return;
      }

      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", style: "destructive", onPress: applySwitch },
      ]);
      return;
    }

    setForm(applyBusinessCategoryChange(prev, id));
    setCategorySwitchHint(
      "We've added suggestions based on your business category."
    );
  }, []);

  // Deliberately does NOT check businessName (or any other required-field
  // validity) here -- the CTA must stay tappable so a missing/invalid field
  // can be explained via inline error + scroll-to-field + banner instead of
  // silently disabling with no explanation. Only genuinely non-actionable
  // states (not signed in, still loading, save already in flight) disable it.
  const canSave =
    Boolean(userId && user?.email) &&
    !loading &&
    !profileLoading &&
    !saving;

  const mode = hasExistingBusiness ? "edit" : "setup";
  const screenTitle =
    mode === "setup"
      ? "Let's set up your business"
      : "Edit your business";
  const screenLead =
    mode === "setup"
      ? "This helps Emily understand your business so it can reply to customers, share pricing, and automate your work."
      : "Help Emily learn your business so she can reply accurately and on-brand.";
  const namePlaceholder =
    mode === "setup" ? "e.g. Khan Electronics" : "Business name";
  const typePlaceholder =
    mode === "setup"
      ? "e.g. Retail, services, rental"
      : "Business type";
  const saveLabel = mode === "setup" ? "Save & Continue" : "Save changes";

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#111111" />
        </View>
      </SafeAreaView>
    );
  }

  if (!userId) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
        <View style={styles.scroll}>
          <Text style={styles.title}>Business</Text>
          <Text style={styles.lead}>Sign in to manage your business profile.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (profileLoading || form === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color="#111111" />
        </View>
      </SafeAreaView>
    );
  }

  const activeCategoryDef = form.categoryId ? getCategoryDef(form.categoryId) : null;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
      {validationBanner ? (
        <View style={styles.floatingBanner} pointerEvents="none">
          <Text style={styles.floatingBannerText}>{validationBanner}</Text>
        </View>
      ) : null}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>{screenTitle}</Text>
          <Text style={styles.lead}>{screenLead}</Text>

          {saveError ? (
            <Text style={styles.feedbackError}>{saveError}</Text>
          ) : null}
          {saveSuccess ? (
            <Text style={styles.feedbackSuccess}>{saveSuccess}</Text>
          ) : null}

          <View
            style={styles.field}
            onLayout={(e) => {
              fieldOffsetsRef.current.businessName = e.nativeEvent.layout.y;
            }}
          >
            <Text style={styles.label}>Business name</Text>
            <TextInput
              ref={businessNameInputRef}
              style={[styles.input, fieldErrors.businessName && styles.inputInvalid]}
              placeholder={namePlaceholder}
              placeholderTextColor="#94A3B8"
              value={form.businessName}
              onChangeText={(text) => {
                setForm((prev) => (prev ? { ...prev, businessName: text } : prev));
              }}
              autoCapitalize="words"
              editable={!saving}
            />
            {fieldErrors.businessName ? (
              <Text style={styles.inlineFieldError}>{fieldErrors.businessName}</Text>
            ) : null}
          </View>

          <View
            style={styles.field}
            onLayout={(e) => {
              fieldOffsetsRef.current.category = e.nativeEvent.layout.y;
            }}
          >
            <Text style={styles.label}>What type of business is this?</Text>
            <BusinessCategoryPicker
              value={form.categoryId}
              disabled={saving}
              onSelect={handleCategorySelect}
            />
            <Text style={styles.helper}>
              {form.categoryId
                ? "This helps Emily understand your business better"
                : "Select a business category to customize your setup."}
            </Text>
            {fieldErrors.category ? (
              <Text style={styles.inlineFieldError}>{fieldErrors.category}</Text>
            ) : null}
            {categorySwitchHint ? (
              <Text style={styles.categorySwitchHint}>{categorySwitchHint}</Text>
            ) : null}
          </View>

          <View
            style={styles.field}
            onLayout={(e) => {
              fieldOffsetsRef.current.ownerPhone = e.nativeEvent.layout.y;
            }}
          >
            <Text style={styles.label}>Owner Notification Phone (WhatsApp)</Text>
            <TextInput
              ref={ownerPhoneInputRef}
              style={[styles.input, fieldErrors.ownerPhone && styles.inputInvalid]}
              placeholder="e.g. 03XXXXXXXXX or +92XXXXXXXXXX"
              placeholderTextColor="#94A3B8"
              value={form.ownerNotificationPhone ?? ""}
              onChangeText={(text) =>
                setForm((prev) =>
                  prev ? { ...prev, ownerNotificationPhone: text } : prev
                )
              }
              keyboardType="phone-pad"
              autoCapitalize="none"
              editable={!saving}
            />
            {fieldErrors.ownerPhone ? (
              <Text style={styles.inlineFieldError}>{fieldErrors.ownerPhone}</Text>
            ) : null}
          </View>

          {form.categoryId ? (
            <>
              <View
                style={styles.field}
                onLayout={(e) => {
                  fieldOffsetsRef.current.businessType = e.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.label}>Business type</Text>
                <BusinessTypePicker
                  value={form.businessType}
                  suggestions={activeCategoryDef?.businessTypeSuggestions ?? []}
                  disabled={saving}
                  error={!!fieldErrors.businessType}
                  onSelect={(text) =>
                    setForm((prev) => (prev ? { ...prev, businessType: text } : prev))
                  }
                />
                {fieldErrors.businessType ? (
                  <Text style={styles.inlineFieldError}>{fieldErrors.businessType}</Text>
                ) : (
                  <Text style={styles.helper}>
                    The specific type within this category — not the category name itself.
                  </Text>
                )}
              </View>

              <View
                onLayout={(e) => {
                  fieldOffsetsRef.current.offerings = e.nativeEvent.layout.y;
                }}
              >
                {fieldErrors.offerings ? (
                  <Text style={[styles.inlineFieldError, styles.offeringsError]}>
                    {fieldErrors.offerings}
                  </Text>
                ) : null}
                <StructuredBusinessSections
                  form={form}
                  setForm={setForm}
                  saving={saving}
                  itemNameErrors={itemNameErrors}
                />
              </View>
            </>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            style={({ pressed }) => [
              styles.saveBtn,
              !canSave && styles.saveBtnDisabled,
              pressed && canSave && styles.saveBtnPressed,
            ]}
            onPress={() => {
              void handleSave();
            }}
            disabled={!canSave}
          >
            {saving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.saveBtnText}>{saveLabel}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#FAFAFA",
  },
  loadingWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: 22,
    paddingBottom: 24,
    paddingTop: 8,
  },
  footer: {
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: Platform.OS === "ios" ? 12 : 16,
    backgroundColor: "#FAFAFA",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E5E7EB",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    color: "#111111",
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  lead: {
    fontSize: 15,
    color: "#666666",
    lineHeight: 22,
    marginBottom: 24,
  },
  feedbackError: {
    color: "#DC2626",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  feedbackSuccess: {
    color: "#15803D",
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  field: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: "#334155",
    marginBottom: 8,
  },
  helper: {
    marginTop: 8,
    fontSize: 13,
    color: "#64748B",
    lineHeight: 18,
  },
  categorySwitchHint: {
    marginTop: 10,
    fontSize: 13,
    color: "#0369A1",
    lineHeight: 18,
  },
  input: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 14 : 12,
    fontSize: 16,
    color: "#111111",
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
  offeringsError: {
    marginTop: 0,
    marginBottom: 10,
  },
  floatingBanner: {
    position: "absolute",
    top: 12,
    left: 22,
    right: 22,
    zIndex: 50,
    backgroundColor: "#111111",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    elevation: 6,
    shadowColor: "#000000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  floatingBannerText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  saveBtn: {
    marginTop: 8,
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveBtnDisabled: {
    opacity: 0.55,
  },
  saveBtnPressed: {
    opacity: 0.88,
  },
  saveBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
});
