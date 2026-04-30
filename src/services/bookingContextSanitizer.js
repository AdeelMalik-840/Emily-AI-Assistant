function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function itemParts(item) {
  if (!item || typeof item !== "object") {
    return { id: "", name: "" };
  }
  const id = clean(item.itemId ?? item.id ?? item.lastResolvedItemId);
  const name = clean(
    item.displayLabel ??
      item.name ??
      item.itemName ??
      item.label ??
      item.lastItemMentioned
  );
  return {
    id,
    name,
  };
}

function itemKey(item) {
  const parts = itemParts(item);
  return parts.id ? `id:${normalizeKey(parts.id)}` : `name:${normalizeKey(parts.name)}`;
}

function sameItem(previousItem, nextItem) {
  const prev = itemParts(previousItem);
  const next = itemParts(nextItem);
  if (prev.id && next.id) return normalizeKey(prev.id) === normalizeKey(next.id);
  if (prev.id || next.id) return false;
  return Boolean(prev.name && next.name && normalizeKey(prev.name) === normalizeKey(next.name));
}

const resetLedger = new WeakMap();

function hasExplicitCurrentItem({
  resolvedItem,
  extractedEntity,
  explicitCurrentMessageItem,
}) {
  const resolved = itemParts(resolvedItem);
  return Boolean(
    (resolved.id || resolved.name) &&
      (clean(extractedEntity) || explicitCurrentMessageItem === true)
  );
}

function hasCurrentSlot(extractedSlots, key) {
  const value = extractedSlots?.[key];
  return value != null && clean(value) !== "";
}

function clearFields(target, fields, clearedFields) {
  if (!target || typeof target !== "object") return;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(target, field)) {
      delete target[field];
      clearedFields.add(field);
    }
  }
}

function restoreCurrentMessageSlots(target, extractedSlots, applied) {
  if (!target || typeof target !== "object") return;
  if (extractedSlots?.durationDays != null && Number.isFinite(Number(extractedSlots.durationDays))) {
    target.lastDuration = Math.max(1, Math.floor(Number(extractedSlots.durationDays)));
    applied.add("durationDays");
  }
  if (hasCurrentSlot(extractedSlots, "contact")) {
    target.contact = clean(extractedSlots.contact);
    applied.add("contact");
  }
  if (hasCurrentSlot(extractedSlots, "contactName")) {
    target.contactName = clean(extractedSlots.contactName);
    target.customerName = clean(extractedSlots.contactName);
    applied.add("contactName");
  }
  if (hasCurrentSlot(extractedSlots, "contactPhone")) {
    target.contactPhone = clean(extractedSlots.contactPhone);
    target.contact = clean(extractedSlots.contactPhone);
    applied.add("contactPhone");
  }
  if (hasCurrentSlot(extractedSlots, "location")) {
    target.location = clean(extractedSlots.location);
    applied.add("location");
  }
  if (hasCurrentSlot(extractedSlots, "city")) {
    target.city = clean(extractedSlots.city);
    applied.add("city");
  }
  if (hasCurrentSlot(extractedSlots, "insideOutsideCity")) {
    target.insideOutsideCity = clean(extractedSlots.insideOutsideCity);
    applied.add("insideOutsideCity");
  }
  if (extractedSlots?.selectedDates != null) {
    target.selectedDates = extractedSlots.selectedDates;
    applied.add("selectedDates");
  }
  if (hasCurrentSlot(extractedSlots, "pickupDate")) {
    target.pickupDate = clean(extractedSlots.pickupDate);
    applied.add("pickupDate");
  }
  if (hasCurrentSlot(extractedSlots, "dropoffDate")) {
    target.dropoffDate = clean(extractedSlots.dropoffDate);
    applied.add("dropoffDate");
  }
}

function bookingSlotFieldsForConversationMemory() {
  return [
    "durationPreference",
    "lastDuration",
    "hasBookingIntent",
    "bookingState",
    "activeBookingId",
    "pendingBookingCandidates",
    "bookingDetails",
    "pendingBooking",
    "selectedDates",
    "pickupDate",
    "dropoffDate",
    "city",
    "location",
    "insideOutsideCity",
    "contact",
    "contactName",
    "contactPhone",
    "customerName",
    "lastAskedField",
    "availabilityConfirmed",
  ];
}

function bookingSlotFieldsForMemory() {
  return [
    "lastDuration",
    "durationPreference",
    "bookingState",
    "activeBookingId",
    "pendingBookingCandidates",
    "bookingDetails",
    "activeBooking",
    "pendingBooking",
    "bookingIntent",
    "hasBookingIntent",
    "selectedDates",
    "city",
    "location",
    "insideOutsideCity",
    "contact",
    "contactName",
    "contactPhone",
    "customerName",
  ];
}

function bookingSlotFieldsForChatContext() {
  return [
    "lastDuration",
    "bookingState",
    "activeBookingId",
    "pendingBookingCandidates",
    "bookingDetails",
    "lastAskedField",
    "contact",
    "city",
    "location",
    "insideOutsideCity",
  ];
}

function resetSignature({
  businessId,
  chatId,
  participantKey,
  chatContextKey,
  sessionKey,
  previousItemKey,
  newItemKey,
  message,
}) {
  return [
    clean(businessId),
    clean(chatId),
    clean(participantKey),
    clean(chatContextKey),
    clean(sessionKey),
    clean(previousItemKey),
    clean(newItemKey),
    clean(message),
  ].join("|");
}

function wasAlreadyReset(target, signature) {
  return Boolean(target && typeof target === "object" && resetLedger.get(target) === signature);
}

function markReset(target, signature) {
  if (target && typeof target === "object") {
    resetLedger.set(target, signature);
  }
}

export function sanitizeContextForResolvedItemChange({
  businessId,
  chatId,
  participantKey,
  conversationMemory,
  memory,
  existingChatContext,
  resolvedItem,
  extractedEntity,
  extractedSlots = {},
  message,
  chatContextKey,
  sessionKey,
  isGroupInbound = false,
  explicitCurrentMessageItem = false,
  explicitItemSource = "extracted_entity",
} = {}) {
  const previousItem =
    conversationMemory?.lastItem && typeof conversationMemory.lastItem === "object"
      ? conversationMemory.lastItem
      : memory?.lastItem && typeof memory.lastItem === "object"
        ? memory.lastItem
        : null;
  const previousItemKey = itemKey(previousItem);
  const newItemKey = itemKey(resolvedItem);
  const explicitNewItem = hasExplicitCurrentItem({
    resolvedItem,
    extractedEntity,
    explicitCurrentMessageItem,
  });
  const currentMessageHasDuration = extractedSlots?.durationDays != null;
  const currentMessageHasContact =
    hasCurrentSlot(extractedSlots, "contact") ||
    hasCurrentSlot(extractedSlots, "contactPhone");
  const currentMessageHasLocation =
    hasCurrentSlot(extractedSlots, "location") ||
    hasCurrentSlot(extractedSlots, "city") ||
    hasCurrentSlot(extractedSlots, "insideOutsideCity");

  console.log("[context_sanitizer_started]", {
    businessId: clean(businessId) || null,
    chatId: clean(chatId) || null,
    participantKey: clean(participantKey) || null,
    previousItemKey: previousItemKey || null,
    newItemKey: newItemKey || null,
    explicitNewItem,
    currentMessageHasDuration,
    currentMessageHasContact,
    currentMessageHasLocation,
    chatContextKey: clean(chatContextKey) || null,
    sessionKey: clean(sessionKey) || null,
  });
  if (clean(explicitItemSource) !== "extracted_entity") {
    console.log("[context_sanitizer_late_started]", {
      explicitItemSource: clean(explicitItemSource) || null,
      previousItemKey: previousItemKey || null,
      newItemKey: newItemKey || null,
      currentMessageHasDuration,
    });
  }
  console.log("[context_sanitizer_explicit_source]", {
    explicitItemSource: clean(explicitItemSource) || null,
    previousItemKey: previousItemKey || null,
    newItemKey: newItemKey || null,
    itemChanged: Boolean(
      explicitNewItem && previousItem && !sameItem(previousItem, resolvedItem)
    ),
    currentMessageHasDuration,
  });

  if (Boolean(isGroupInbound) && !clean(participantKey) && clean(chatId)) {
    console.warn("[context_cross_participant_reuse_blocked]", {
      businessId: clean(businessId) || null,
      chatId: clean(chatId) || null,
      reason: "MISSING_PARTICIPANT_KEY",
    });
  }

  if (!explicitNewItem) {
    console.log("[context_sanitizer_skip_no_explicit_item]", {
      previousItemKey: previousItemKey || null,
      newItemKey: newItemKey || null,
      messagePreview: clean(message).slice(0, 120) || null,
    });
    return {
      itemChanged: false,
      explicitNewItem: false,
      previousItemKey,
      newItemKey,
      clearedFields: [],
      currentMessageSlotsApplied: [],
    };
  }

  if (!previousItem || sameItem(previousItem, resolvedItem)) {
    console.log("[context_sanitizer_no_reset_same_item]", {
      previousItemKey: previousItemKey || null,
      newItemKey: newItemKey || null,
    });
    return {
      itemChanged: false,
      explicitNewItem: true,
      previousItemKey,
      newItemKey,
      clearedFields: [],
      currentMessageSlotsApplied: [],
    };
  }

  const signature = resetSignature({
    businessId,
    chatId,
    participantKey,
    chatContextKey,
    sessionKey,
    previousItemKey,
    newItemKey,
    message,
  });
  if (
    wasAlreadyReset(conversationMemory, signature) ||
    wasAlreadyReset(memory, signature) ||
    wasAlreadyReset(existingChatContext, signature)
  ) {
    console.log("[context_sanitizer_no_reset_same_item]", {
      previousItemKey: previousItemKey || null,
      newItemKey: newItemKey || null,
      reason: "ALREADY_RESET_FOR_MESSAGE_ITEM",
    });
    return {
      itemChanged: false,
      explicitNewItem: true,
      previousItemKey,
      newItemKey,
      clearedFields: [],
      currentMessageSlotsApplied: [],
    };
  }

  const clearedFields = new Set();
  const currentMessageSlotsApplied = new Set();
  clearFields(
    conversationMemory,
    bookingSlotFieldsForConversationMemory(),
    clearedFields
  );
  if (memory && memory !== conversationMemory) {
    clearFields(memory, bookingSlotFieldsForMemory(), clearedFields);
  }
  clearFields(existingChatContext, bookingSlotFieldsForChatContext(), clearedFields);
  if (
    existingChatContext &&
    /^(booking|order|confirmation|duration)$/i.test(clean(existingChatContext.lastIntent))
  ) {
    delete existingChatContext.lastIntent;
    clearedFields.add("lastIntent");
  }

  restoreCurrentMessageSlots(conversationMemory, extractedSlots, currentMessageSlotsApplied);
  if (memory && memory !== conversationMemory) {
    restoreCurrentMessageSlots(memory, extractedSlots, currentMessageSlotsApplied);
  }
  restoreCurrentMessageSlots(
    existingChatContext,
    extractedSlots,
    currentMessageSlotsApplied
  );

  console.log("[context_sanitizer_item_changed_reset]", {
    previousItemKey: previousItemKey || null,
    newItemKey: newItemKey || null,
    clearedFields: Array.from(clearedFields).sort(),
    currentMessageSlotsApplied: Array.from(currentMessageSlotsApplied).sort(),
  });

  markReset(conversationMemory, signature);
  markReset(memory, signature);
  markReset(existingChatContext, signature);

  return {
    itemChanged: true,
    explicitNewItem: true,
    previousItemKey,
    newItemKey,
    clearedFields: Array.from(clearedFields).sort(),
    currentMessageSlotsApplied: Array.from(currentMessageSlotsApplied).sort(),
  };
}
