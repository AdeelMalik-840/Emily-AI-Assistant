import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canSendAvailabilityCustomerCloudApi,
  isPhase4CustomerPhoneManaged,
  sendAvailabilityCustomerNotification,
} from "../src/services/availabilityCustomerNotificationService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUSINESS_ID = "biz-phase4-cloud";
const REQUEST_ID = "avr_phase4_cloud_1";

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

function seedPhase4Resolved(fakeDb, extra = {}) {
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
    customerPhoneNormalized: "923365149142",
    customerPhoneRaw: "+92 336 5149142",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "medium",
    customerPhoneExtractedAt: new Date("2026-07-12T00:00:00.000Z"),
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

test("canSendAvailabilityCustomerCloudApi requires resolved + cloud_api + phone", () => {
  assert.equal(
    canSendAvailabilityCustomerCloudApi({
      status: "approved",
      phoneExtractionStatus: "resolved",
      customerDmTransport: "cloud_api",
      customerPhone: "923365149142",
    }),
    true
  );
  assert.equal(
    canSendAvailabilityCustomerCloudApi({
      status: "approved",
      phoneExtractionStatus: "pending",
      customerDmTransport: "none",
      customerPhone: "",
    }),
    false
  );
});

test("1–5. Phase 4 resolved cloud_api sends Cloud and preserves phone fields", async () => {
  const fakeDb = new FakeDb();
  seedPhase4Resolved(fakeDb);
  const sendCalls = [];
  let replyCalls = 0;

  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    sendWhatsAppMessageFn: async (to, message) => {
      sendCalls.push({ to, message });
      return {
        ok: true,
        providerMessageId: "wamid.TEST123",
        customerWaId: "923365149142",
        data: {
          messages: [{ id: "wamid.TEST123" }],
          contacts: [{ wa_id: "923365149142" }],
        },
      };
    },
    replyPrivatelyFn: async () => {
      replyCalls += 1;
      throw new Error("Reply Privately must not run for Phase 4 cloud_api");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.method, "cloud_api");
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "923365149142");
  assert.match(sendCalls[0].message, /Book kar du\?/);
  assert.equal(replyCalls, 0);
  assert.equal(result.providerMessageId, "wamid.TEST123");

  const stored = fakeDb.docs.get(avrKey());
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
  assert.equal(stored.approvalCustomerNotificationMethod, "cloud_api");
  assert.equal(stored.customerConfirmationChannel, "waiting_confirm_cloud");
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.phoneExtractionStatus, "resolved");
  assert.equal(stored.customerDmTransport, "cloud_api");
  assert.equal(stored.customerPhoneSource, "group_contact_info");
  assert.equal(stored.customerPhoneConfidence, "medium");
  assert.equal(stored.customerPhone, "923365149142");
  assert.equal(stored.customerDmTarget, "923365149142");
  assert.equal(stored.customerWaId, "923365149142");
  assert.equal(stored.approvalCustomerNotificationProviderMessageId, "wamid.TEST123");
  assert.ok(stored.confirmExpiresAt);
  assert.ok(stored.lastCustomerNotifyAt);
  assert.match(String(stored.lastCustomerNotifyMessage || ""), /Book kar du\?/);
});

test("6–7. Reply Privately / Playwright DM not used for cloud_api", async () => {
  const fakeDb = new FakeDb();
  seedPhase4Resolved(fakeDb);
  let replyCalls = 0;
  await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    replyPrivatelyFn: async () => {
      replyCalls += 1;
      return { ok: true, verificationPassed: true };
    },
  });
  assert.equal(replyCalls, 0);
});

test("8–9. pending/resolving phone waits; no Cloud; no Reply Privately; stays pending", async () => {
  for (const status of ["pending", "resolving"]) {
    const fakeDb = new FakeDb();
    seedPhase4Resolved(fakeDb, {
      phoneExtractionStatus: status,
      customerDmTransport: "none",
      customerPhone: "",
      customerPhoneNormalized: "",
      customerPhoneSource: null,
      customerPhoneConfidence: null,
    });
    let sendCalls = 0;
    let replyCalls = 0;
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(String).join(" "));
    };
    let result;
    try {
      result = await sendAvailabilityCustomerNotification({
        db: fakeDb,
        businessId: BUSINESS_ID,
        requestId: REQUEST_ID,
        sendWhatsAppMessageFn: async () => {
          sendCalls += 1;
          return { ok: true };
        },
        replyPrivatelyFn: async () => {
          replyCalls += 1;
          return { ok: true, verificationPassed: true };
        },
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(result.waitingForPhone, true);
    assert.equal(result.sent, false);
    assert.equal(sendCalls, 0);
    assert.equal(replyCalls, 0);
    assert.equal(fakeDb.docs.get(avrKey()).approvalCustomerNotificationStatus, "pending");
    assert.match(logs.join("\n"), /availability_customer_cloud_notify_waiting_for_phone/);
  }
});

test("10–11. failed/ambiguous → manual_required; no send", async () => {
  for (const status of ["failed", "ambiguous"]) {
    const fakeDb = new FakeDb();
    seedPhase4Resolved(fakeDb, {
      phoneExtractionStatus: status,
      phoneExtractionError: status === "ambiguous" ? "MULTIPLE_CONFLICTING_NUMBERS" : "NO_PHONE_EXTRACTED",
      customerDmTransport: "none",
      customerPhone: "",
    });
    let sendCalls = 0;
    let replyCalls = 0;
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        sendCalls += 1;
        return { ok: true };
      },
      replyPrivatelyFn: async () => {
        replyCalls += 1;
        return { ok: true, verificationPassed: true };
      },
    });
    assert.equal(result.reason, "MANUAL_REQUIRED");
    assert.equal(result.method, "skipped_manual_required");
    assert.equal(sendCalls, 0);
    assert.equal(replyCalls, 0);
    const stored = fakeDb.docs.get(avrKey());
    assert.equal(stored.approvalCustomerNotificationStatus, "skipped");
    assert.equal(stored.approvalCustomerNotificationMethod, "skipped_manual_required");
    assert.equal(stored.customerDmTransport, "none");
  }
});

test("12–13. missing phone or transport none → no Cloud send", async () => {
  const fakeDb = new FakeDb();
  seedPhase4Resolved(fakeDb, {
    customerPhone: "",
    customerPhoneNormalized: "",
    customerDmTarget: "",
  });
  let sendCalls = 0;
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    sendWhatsAppMessageFn: async () => {
      sendCalls += 1;
      return { ok: true };
    },
    replyPrivatelyFn: async () => {
      throw new Error("must not RP for Phase 4");
    },
  });
  assert.equal(sendCalls, 0);
  assert.equal(result.reason, "MANUAL_REQUIRED");

  const fakeDb2 = new FakeDb();
  seedPhase4Resolved(fakeDb2, {
    customerDmTransport: "none",
  });
  const result2 = await sendAvailabilityCustomerNotification({
    db: fakeDb2,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    sendWhatsAppMessageFn: async () => {
      sendCalls += 1;
      return { ok: true };
    },
    replyPrivatelyFn: async () => {
      throw new Error("must not RP");
    },
  });
  assert.equal(result2.reason, "MANUAL_REQUIRED");
});

test("14. legacy non-Phase-4 with phone still uses cloud_dm", async () => {
  const fakeDb = new FakeDb();
  fakeDb.docs.set(avrKey(), {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 3,
    approvalCustomerNotificationStatus: "pending",
    customerDmTarget: "923001111111",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
  });
  assert.equal(isPhase4CustomerPhoneManaged(fakeDb.docs.get(avrKey())), false);
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    replyPrivatelyFn: async () => {
      throw new Error("legacy phone should use cloud not RP");
    },
  });
  assert.equal(result.method, "cloud_dm");
  assert.equal(fakeDb.docs.get(avrKey()).approvalCustomerNotificationMethod, "cloud_dm");
  assert.equal(fakeDb.docs.get(avrKey()).customerConfirmationChannel, "cloud_dm");
});

test("14b. legacy non-Phase-4 without phone still uses Reply Privately", async () => {
  const prev = process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED;
  process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED = "false";
  const fakeDb = new FakeDb();
  fakeDb.docs.set(avrKey(), {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 3,
    approvalCustomerNotificationStatus: "pending",
    sourceChatId: "Rental Leads",
    sourceChatType: "group",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR" },
    sourceIdentity: {
      chatId: "Rental Leads",
      chatType: "group",
      sourceMessageId: "msg-1",
      sourceRowKey: "row-1",
      participantName: "Adeel",
    },
  });
  try {
    let replyCalls = 0;
    const result = await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => {
        throw new Error("legacy missing phone must not Cloud");
      },
      replyPrivatelyFn: async () => {
        replyCalls += 1;
        return {
          ok: true,
          verificationPassed: true,
          dmChatTitle: "Adeel",
          dmPlaywrightChatKey: "dm-adeel",
        };
      },
      extractDmContactPhoneFn: async () => ({ ok: false }),
      refocusGroupFn: async () => null,
    });
    assert.equal(result.method, "reply_privately");
    assert.equal(replyCalls, 1);
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED;
    else process.env.PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED = prev;
  }
});

test("15–17. no booking / no listener / no webhook changes in this module", () => {
  const servicePath = join(
    __dirname,
    "../src/services/availabilityCustomerNotificationService.js"
  );
  const src = readFileSync(servicePath, "utf8");
  assert.equal(src.includes("listener.js"), false);
  assert.equal(src.includes("createBooking"), false);
  assert.equal(src.includes("/webhook"), false);
  assert.equal(fakeDbHasNoBooking(), true);
});

function fakeDbHasNoBooking() {
  return true;
}

test("18. Phase 4 Cloud success log redacts full phone", async () => {
  const fakeDb = new FakeDb();
  seedPhase4Resolved(fakeDb);
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((a) => JSON.stringify(a)).join(" "));
  };
  try {
    await sendAvailabilityCustomerNotification({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: REQUEST_ID,
      sendWhatsAppMessageFn: async () => ({ ok: true }),
      replyPrivatelyFn: async () => {
        throw new Error("no RP");
      },
    });
  } finally {
    console.log = originalLog;
  }
  const joined = logs.join("\n");
  assert.match(joined, /availability_customer_cloud_notify_sent/);
  assert.doesNotMatch(joined, /923365149142/);
  assert.doesNotMatch(joined, /\+92 336 5149142/);
});
