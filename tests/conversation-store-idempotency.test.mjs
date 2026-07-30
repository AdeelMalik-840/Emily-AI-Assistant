import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  appendConversationMessage,
  getRecentConversationForPrompt,
} = await import("../src/services/conversationStore.js");

function createConversationDb(initialMessages = []) {
  const docs = new Map();
  const writes = [];
  let transactionTail = Promise.resolve();

  class Ref {
    constructor(id) {
      this.id = id;
    }
    async get() {
      const data = docs.get(this.id);
      return {
        exists: Boolean(data),
        data: () => (data ? structuredClone(data) : undefined),
      };
    }
  }

  const db = {
    collection(name) {
      assert.equal(name, "conversations");
      return {
        doc(id) {
          return new Ref(id);
        },
      };
    },
    async runTransaction(fn) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const tx = {
          async get(ref) {
            return ref.get();
          },
          set(ref, payload, options) {
            const prior = docs.get(ref.id) ?? {};
            const next = options?.merge ? { ...prior, ...payload } : payload;
            docs.set(ref.id, structuredClone(next));
            writes.push({ ref: ref.id, payload: structuredClone(payload) });
          },
        };
        return await fn(tx);
      } finally {
        release();
      }
    },
  };

  if (initialMessages.length > 0) {
    docs.set("biz-1_923001234567", {
      userId: "biz-1",
      customerNumber: "923001234567",
      messages: structuredClone(initialMessages),
    });
  }

  return {
    db,
    docs,
    writes,
    messages() {
      return docs.get("biz-1_923001234567")?.messages ?? [];
    },
  };
}

test("same role and sourceMessageId append once while same text with different IDs remains distinct", async () => {
  const fake = createConversationDb();
  const common = {
    ownerUserId: "biz-1",
    customerNumber: "923001234567",
    role: "user",
    text: "Kitny din k lye book ki h?",
  };
  assert.equal(
    await appendConversationMessage(fake.db, {
      ...common,
      sourceMessageId: "wamid.in-1",
      providerMessageId: "wamid.in-1",
    }),
    true
  );
  assert.equal(
    await appendConversationMessage(fake.db, {
      ...common,
      sourceMessageId: "wamid.in-1",
      providerMessageId: "wamid.in-1",
    }),
    false
  );
  assert.equal(
    await appendConversationMessage(fake.db, {
      ...common,
      sourceMessageId: "wamid.in-2",
      providerMessageId: "wamid.in-2",
    }),
    true
  );

  assert.equal(fake.messages().length, 2);
  assert.deepEqual(
    fake.messages().map((row) => row.sourceMessageId),
    ["wamid.in-1", "wamid.in-2"]
  );
});

test("two concurrent appends with one source identity create exactly one entry", async () => {
  const fake = createConversationDb();
  const message = {
    ownerUserId: "biz-1",
    customerNumber: "923001234567",
    role: "assistant",
    text: "Toyota Corolla 4 din ke liye book hai.",
    sourceMessageId: "wamid.in-question",
    providerMessageId: "wamid.out-one",
  };

  const results = await Promise.all([
    appendConversationMessage(fake.db, message),
    appendConversationMessage(fake.db, message),
  ]);

  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(fake.messages().length, 1);
  assert.equal(fake.writes.length, 1);
});

test("same source identity with conflicting text is rejected and diagnosed", async () => {
  const fake = createConversationDb();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(
      await appendConversationMessage(fake.db, {
        ownerUserId: "biz-1",
        customerNumber: "923001234567",
        role: "assistant",
        text: "Toyota Corolla 4 din ke liye book hai.",
        sourceMessageId: "wamid.in-question",
        providerMessageId: "wamid.out-one",
      }),
      true
    );
    assert.equal(
      await appendConversationMessage(fake.db, {
        ownerUserId: "biz-1",
        customerNumber: "923001234567",
        role: "assistant",
        text: "Toyota Corolla 5 din ke liye book hai.",
        sourceMessageId: "wamid.in-question",
        providerMessageId: "wamid.out-two",
      }),
      false
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fake.messages().length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "[conversation_identity_conflict]");
  assert.deepEqual(warnings[0][1], {
    role: "assistant",
    sourceMessageId: "wamid.in-question",
    existingTextLength: 38,
    incomingTextLength: 38,
  });
});

test("normal send and send-only recovery cannot duplicate one assistant entry", async () => {
  const fake = createConversationDb();
  const assistant = {
    ownerUserId: "biz-1",
    customerNumber: "923001234567",
    role: "assistant",
    text: "Toyota Corolla 4 din ke liye book hai.",
    sourceMessageId: "wamid.in-question",
  };
  await appendConversationMessage(fake.db, {
    ...assistant,
    providerMessageId: "wamid.out-first",
  });
  await appendConversationMessage(fake.db, {
    ...assistant,
    providerMessageId: "wamid.out-recovery",
  });

  assert.equal(fake.messages().length, 1);
  assert.equal(fake.messages()[0].providerMessageId, "wamid.out-first");
});

test("legacy entries remain valid and prompt rendering is unchanged", async () => {
  const fake = createConversationDb([
    {
      role: "assistant",
      text: "Booking confirm ho gayi.",
      timestamp: new Date("2026-07-30T13:18:52Z"),
    },
  ]);
  await appendConversationMessage(fake.db, {
    ownerUserId: "biz-1",
    customerNumber: "923001234567",
    role: "user",
    text: "Kitny din k lye book ki h?",
    sourceMessageId: "wamid.in-followup",
    providerMessageId: "wamid.in-followup",
  });

  const prompt = await getRecentConversationForPrompt(
    fake.db,
    "biz-1",
    "923001234567",
    20
  );
  assert.equal(
    prompt,
    "Assistant: Booking confirm ho gayi.\nUser: Kitny din k lye book ki h?"
  );
});
