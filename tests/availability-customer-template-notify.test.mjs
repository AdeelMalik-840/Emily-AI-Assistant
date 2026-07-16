import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAvailabilityCustomerLanguage,
  planAvailabilityCustomerTemplateSend,
  renderAvailabilityCustomerTemplatePreview,
  resolveAvailabilityCustomerTemplateSelection,
} from "../src/services/availabilityCustomerTemplateNotify.js";
import { sendAvailabilityCustomerNotification } from "../src/services/availabilityCustomerNotificationService.js";

const BUSINESS_ID = "biz-template-4f";
const REQUEST_ID = "avr_template_4f_1";

const TEMPLATE_ENV_KEYS = [
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENABLED",
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_NAME",
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_LANGUAGE",
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_NAME",
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_LANGUAGE",
  "WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_DEFAULT",
];

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  get id() {
    const parts = this.key.split("/");
    return parts[parts.length - 1];
  }
  data() {
    return this.store.docs.has(this.key)
      ? structuredClone(this.store.docs.get(this.key))
      : undefined;
  }
}

class FakeDocRef {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prev = this.store.docs.get(this.key) || {};
    const next =
      options && options.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) throw new Error("MISSING_DOC");
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
}

class FakeCollectionRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)].join("/"));
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
    this.bookings = new Map();
  }
  collection(name) {
    return {
      doc: (id) => ({
        collection: (childName) =>
          new FakeCollectionRef(this, [name, String(id), childName]),
      }),
    };
  }
}

function avrKey(requestId = REQUEST_ID) {
  return `businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`;
}

function saveTemplateEnv() {
  const saved = {};
  for (const key of TEMPLATE_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreTemplateEnv(saved) {
  for (const key of TEMPLATE_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function enableTemplateEnv(overrides = {}) {
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENABLED = "true";
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_NAME =
    "availability_quote_ru_v1";
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_LANGUAGE = "en_US";
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_NAME =
    "availability_quote_en_v1";
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_LANGUAGE = "en_US";
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_DEFAULT = "roman_urdu";
  Object.assign(process.env, overrides);
}

function seedGroupApproved(fakeDb, extra = {}) {
  fakeDb.docs.set(avrKey(), {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    status: "approved",
    requestedDuration: 2,
    approvalCustomerNotificationStatus: "pending",
    priceQuote: { status: "quoted", total: 16000, currency: "PKR" },
    customerPhone: "923365149142",
    phoneExtractionStatus: "resolved",
    phoneExtractionError: null,
    customerDmTransport: "cloud_api",
    sourceChatId: "Rental Leads",
    sourceChatType: "group",
    sourceIdentity: {
      participantName: "Adeel",
      sourceMessageId: "MSG1",
      sourceRowKey: "row1",
      sourceTextPreview: "civic 2 din",
      chatId: "Rental Leads",
      chatType: "group",
    },
    ...extra,
  });
}

test("language classifier: english / roman_urdu / mixed / unknown", () => {
  assert.equal(
    classifyAvailabilityCustomerLanguage("Is the Honda Civic available for 2 days?"),
    "english"
  );
  assert.equal(
    classifyAvailabilityCustomerLanguage("Civic 2 din k liye available hai?"),
    "roman_urdu"
  );
  assert.equal(
    classifyAvailabilityCustomerLanguage("Civic 2 din available please book"),
    "mixed"
  );
  assert.equal(classifyAvailabilityCustomerLanguage(""), "unknown");
});

test("1. group Roman Urdu request sends Roman Urdu template", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb, {
    sourceIdentity: {
      chatType: "group",
      chatId: "Rental Leads",
      sourceTextPreview: "civic 2 din chahiye",
    },
  });
  const templateCalls = [];
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("free-form must not run when template enabled");
      },
      sendWhatsAppTemplateMessageFn: async (payload) => {
        templateCalls.push(payload);
        return {
          ok: true,
          providerMessageId: "wamid.template.ru",
          data: { messages: [{ id: "wamid.template.ru" }] },
        };
      },
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
    });
    assert.equal(result.method, "cloud_api_template");
    assert.equal(templateCalls.length, 1);
    assert.equal(templateCalls[0].templateName, "availability_quote_ru_v1");
    assert.equal(templateCalls[0].languageCode, "en_US");
    assert.equal(fakeDb.docs.get(avrKey()).customerLanguage, "roman_urdu");
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("2. group English request sends English template", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb, {
    sourceIdentity: {
      chatType: "group",
      chatId: "Rental Leads",
      sourceTextPreview: "Is the Honda Civic available for 2 days?",
    },
  });
  const templateCalls = [];
  try {
    await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("free-form must not run");
      },
      sendWhatsAppTemplateMessageFn: async (payload) => {
        templateCalls.push(payload);
        return { ok: true, providerMessageId: "wamid.template.en" };
      },
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
    });
    assert.equal(templateCalls[0].templateName, "availability_quote_en_v1");
    assert.equal(fakeDb.docs.get(avrKey()).customerLanguage, "english");
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("3. mixed/unknown defaults to Roman Urdu template", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb, {
    sourceIdentity: {
      chatType: "group",
      chatId: "Rental Leads",
      sourceTextPreview: "",
    },
  });
  const templateCalls = [];
  try {
    await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("free-form must not run");
      },
      sendWhatsAppTemplateMessageFn: async (payload) => {
        templateCalls.push(payload);
        return { ok: true, providerMessageId: "wamid.template.default" };
      },
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
    });
    assert.equal(templateCalls[0].templateName, "availability_quote_ru_v1");
    assert.equal(fakeDb.docs.get(avrKey()).customerLanguage, "unknown");
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("4. template payload parameter order: item, duration, total rent", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb);
  const templateCalls = [];
  try {
    await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      sendWhatsAppTemplateMessageFn: async (payload) => {
        templateCalls.push(payload);
        return { ok: true, providerMessageId: "wamid.params" };
      },
      replyPrivatelyFn: async () => ({ ok: true }),
    });
    assert.deepEqual(templateCalls[0].bodyParameters, [
      "Honda Civic 2026 Oriel (White)",
      "2",
      "16,000",
    ]);
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("5–11. template send persists Firestore fields and rendered preview", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb);
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("free-form must not run");
      },
      sendWhatsAppTemplateMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.template.fields",
        customerWaId: "923365149142",
        data: {
          messages: [{ id: "wamid.template.fields" }],
          contacts: [{ wa_id: "923365149142" }],
        },
      }),
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
    });
    assert.equal(result.method, "cloud_api_template");
    const stored = fakeDb.docs.get(avrKey());
    assert.equal(stored.approvalCustomerNotificationMethod, "cloud_api_template");
    assert.equal(stored.customerDeliveryStatus, "pending");
    assert.equal(stored.approvalCustomerNotificationProviderMessageId, "wamid.template.fields");
    assert.equal(stored.approvalCustomerNotificationTemplateName, "availability_quote_ru_v1");
    assert.equal(stored.approvalCustomerNotificationTemplateLanguage, "en_US");
    assert.equal(stored.customerLanguage, "roman_urdu");
    assert.equal(stored.customerConfirmationChannel, "waiting_confirm_cloud");
    assert.match(
      String(stored.lastCustomerNotifyMessage || ""),
      /Honda Civic 2026 Oriel \(White\) 2 din ke liye available hai/
    );
    assert.match(String(stored.lastCustomerNotifyMessage || ""), /16,000 PKR hoga/);
    assert.match(String(stored.lastCustomerNotifyMessage || ""), /Book kar du\?/);
    assert.equal(fakeDb.bookings.size, 0);
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("12. missing template config fails closed; no free-form send", async () => {
  const saved = saveTemplateEnv();
  process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENABLED = "true";
  delete process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_NAME;
  delete process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_NAME;
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb);
  let textCalls = 0;
  let templateCalls = 0;
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        textCalls += 1;
        return { ok: true };
      },
      sendWhatsAppTemplateMessageFn: async () => {
        templateCalls += 1;
        return { ok: true };
      },
      replyPrivatelyFn: async () => ({ ok: true }),
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "MANUAL_REQUIRED");
    assert.equal(textCalls, 0);
    assert.equal(templateCalls, 0);
    assert.equal(
      fakeDb.docs.get(avrKey()).approvalCustomerNotificationMethod,
      "skipped_manual_required"
    );
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("13. missing price/duration fails closed; no free-form send", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb, {
    requestedDuration: null,
    priceQuote: null,
  });
  let textCalls = 0;
  let templateCalls = 0;
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        textCalls += 1;
        return { ok: true };
      },
      sendWhatsAppTemplateMessageFn: async () => {
        templateCalls += 1;
        return { ok: true };
      },
      replyPrivatelyFn: async () => ({ ok: true }),
    });
    assert.equal(result.skipped, true);
    assert.equal(result.templateBlockedReason, "TEMPLATE_PARAMS_MISSING");
    assert.equal(textCalls, 0);
    assert.equal(templateCalls, 0);
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("14. non-group Phase 4 path remains free-form when template enabled", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb, {
    sourceChatType: "individual",
    sourceIdentity: {
      chatType: "individual",
      chatId: "923001111111",
      sourceTextPreview: "civic 2 din",
    },
  });
  const textCalls = [];
  let templateCalls = 0;
  try {
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async (to, message) => {
        textCalls.push({ to, message });
        return { ok: true, providerMessageId: "wamid.freeform" };
      },
      sendWhatsAppTemplateMessageFn: async () => {
        templateCalls += 1;
        return { ok: true };
      },
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
    });
    assert.equal(result.method, "cloud_api");
    assert.equal(textCalls.length, 1);
    assert.equal(templateCalls, 0);
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("15–16. Reply Privately and Playwright DM continuation are not called", async () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  const fakeDb = new FakeDb();
  seedGroupApproved(fakeDb);
  try {
    await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("unexpected text send");
      },
      sendWhatsAppTemplateMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.no.rp",
      }),
      replyPrivatelyFn: async () => {
        throw new Error("Reply Privately must not run");
      },
      extractDmContactPhoneFn: async () => {
        throw new Error("Playwright DM continuation must not run");
      },
    });
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("template preview render for English bucket", () => {
  const preview = renderAvailabilityCustomerTemplatePreview("english", {
    itemLabel: "Honda Civic 2026",
    durationDays: 2,
    total: 16000,
    currency: "PKR",
  });
  assert.match(preview, /is available for 2 days/);
  assert.match(preview, /16,000 PKR/);
  assert.match(preview, /Should I book it for you\?/);
});

test("planAvailabilityCustomerTemplateSend resolves mixed to default Roman Urdu template", () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  try {
    const plan = planAvailabilityCustomerTemplateSend({
      itemLabel: "Civic",
      requestedDuration: 2,
      priceQuote: { total: 10000, currency: "PKR" },
      sourceIdentity: { sourceTextPreview: "civic 2 din available please book" },
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.templateName, "availability_quote_ru_v1");
    assert.equal(plan.customerLanguage, "mixed");
  } finally {
    restoreTemplateEnv(saved);
  }
});

test("resolveAvailabilityCustomerTemplateSelection honors english bucket", () => {
  const saved = saveTemplateEnv();
  enableTemplateEnv();
  try {
    const config = {
      defaultBucket: "roman_urdu",
      english: { name: "availability_quote_en_v1", language: "en_US" },
      romanUrdu: { name: "availability_quote_ru_v1", language: "en_US" },
    };
    const sel = resolveAvailabilityCustomerTemplateSelection("english", config);
    assert.equal(sel.ok, true);
    assert.equal(sel.templateName, "availability_quote_en_v1");
  } finally {
    restoreTemplateEnv(saved);
  }
});
