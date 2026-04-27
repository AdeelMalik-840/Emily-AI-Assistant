import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeAgainstPriorAssistantReplies } from "../src/services/whatsappReplyTone.js";

test("keeps valid AI reply instead of replacing it with stale dedupe fallback", () => {
  const aiReply =
    "Yeh Kia Stonic EX Plus 2021 rental ke liye available hai. Price 12000 per day hai.";
  const prior = [
    "Yeh Kia Stonic EX Plus 2021 rental ke liye available hai. Price 12000 per day hai.",
  ];

  const out = dedupeAgainstPriorAssistantReplies(aiReply, prior);

  assert.equal(out, aiReply);
  assert.notEqual(
    out,
    "Yeh rental details main ne pehle share kar di hain — koi aur sawaal ya doosri gari ki info chahiye ho to bata dein."
  );
});

test("uses fallback only when AI reply is empty", () => {
  const out = dedupeAgainstPriorAssistantReplies("", [], {
    fallbackText: "Could you please clarify what you're looking for?",
  });

  assert.equal(out, "Could you please clarify what you're looking for?");
});
