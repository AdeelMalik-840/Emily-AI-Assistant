import test from "node:test";
import assert from "node:assert/strict";

import { verifyReplyPrivatelyMessageSent } from "../src/services/playwrightReplyPrivatelyBridge.js";

function fakeSnapshots({ preCount = 1, postCount = 2, preSig = "a::hi", postSig = "b::sent", postText = "sent" } = {}) {
  const pre = { count: preCount, lastSig: preSig, lastText: "hi" };
  const post = { count: postCount, lastSig: postSig, lastText: postText };
  return { pre, post };
}

test("send verification does not fail when header candidates change but normalized chat key matches", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online", "Business Account"],
      }),
    }
  );
  assert.equal(result.ok, true);
});

test("send verification ignores unstable header when dmLock is present", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Business Account",
        candidates: ["Business Account", "online"],
      }),
    }
  );
  assert.equal(result.ok, true);
});

test("send verification fails when actual normalized chat key changes", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Rental Leads",
        candidates: ["Rental Leads"],
      }),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DM_CHAT_CHANGED");
});

