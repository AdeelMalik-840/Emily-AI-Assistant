export const TONE_STYLE = "kar_deta_hun";

const UNKNOWN_FALLBACKS = {
  kar_deta_hun: [
    "Confirm kar ke bata deta hun 👍",
    "Check kar ke batata hun 👍",
    "Iska exact confirm kar ke bata deta hun 👍",
  ],
  karwa_deta_hun: [
    "Confirm karwa deta hun 👍",
    "Check karwa ke bata deta hun 👍",
    "Iska exact confirm karwa deta hun 👍",
  ],
};

const DURATION_QUESTIONS = [
  "Kitne din ke liye chahiye?",
  "Kitne time ke liye chahiye?",
  "Kitne din ka plan hai?",
];

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function isInformational(routeType) {
  return String(routeType ?? "").toUpperCase() === "INFORMATIONAL_QUESTION";
}

function isCasualReplyText(userMessage) {
  const text = normalize(userMessage);
  return /^(ok|okay|haan|han|hmm|hm|theek|thik|acha|achha|👍|👍🏻|👍🏼|👍🏽|yes|ji|g)$/i.test(
    text
  );
}

function showsProceedIntent(userMessage) {
  const text = normalize(userMessage);
  return /\b(book|booking|confirm|reserve|chahiye|chaiye|chaheye|chahye|len[ai]?|le\s*loon|kar\s*do|final)\b/i.test(
    text
  );
}

function asksOrStatesDuration(textValue) {
  const text = normalize(textValue);
  return /\b(kitne\s+(?:din|time)|kitna\s+time|how\s+(?:long|many\s+days)|for\s+how\s+long|duration|din\s+ke\s+liye)\b/i.test(
    text
  );
}

function recentQuestionType(conversationState = {}, lastAssistantMessage = "") {
  const explicit = clean(conversationState.lastAskedQuestionType);
  if (explicit) return explicit;
  if (asksOrStatesDuration(lastAssistantMessage)) return "duration";
  return null;
}

function wasAskedRecently(conversationState = {}, questionType, now = Date.now()) {
  if (!questionType) return false;
  if (clean(conversationState.lastAskedQuestionType) !== questionType) return false;
  const ts = Number(conversationState.lastAskedTimestamp);
  if (!Number.isFinite(ts) || ts <= 0) return true;
  return now - ts <= 10 * 60 * 1000;
}

export function decideResponseStrategy({
  userMessage,
  lastAssistantMessage,
  conversationState = {},
  routeType,
  answerKnown = false,
} = {}) {
  const lastQuestionType = recentQuestionType(conversationState, lastAssistantMessage);
  const casualReply = isCasualReplyText(userMessage);

  if (casualReply) {
    return {
      strategy: "ask_clarification",
      reason: lastQuestionType ? `casual_reply_after_${lastQuestionType}` : "casual_reply_unclear",
    };
  }

  if (
    isInformational(routeType) &&
    lastQuestionType === "duration" &&
    !showsProceedIntent(userMessage)
  ) {
    return {
      strategy: "answer_only",
      reason: "informational_after_duration_prompt",
    };
  }

  if (isInformational(routeType) && showsProceedIntent(userMessage)) {
    return {
      strategy: "answer_then_guide",
      reason: answerKnown ? "informational_with_proceed_intent" : "unknown_with_proceed_intent",
    };
  }

  if (isInformational(routeType)) {
    return {
      strategy: "answer_only",
      reason: "informational_question",
    };
  }

  return {
    strategy: "no_followup",
    reason: "non_conversational_route",
  };
}

export function selectVariation(poolName, { index = null, random = Math.random } = {}) {
  const pool =
    poolName === "duration_question"
      ? DURATION_QUESTIONS
      : UNKNOWN_FALLBACKS[TONE_STYLE] || UNKNOWN_FALLBACKS.kar_deta_hun;
  const safeIndex =
    Number.isInteger(index) && index >= 0
      ? index % pool.length
      : Math.floor(random() * pool.length) % pool.length;
  return {
    text: pool[safeIndex],
    poolName,
    index: safeIndex,
  };
}

export function enforceToneStyle(reply, toneStyle = TONE_STYLE) {
  let text = clean(reply);
  if (toneStyle === "kar_deta_hun") {
    text = text
      .replace(/\bconfirm\s+karwa\s+deta\s+hun\b/gi, "confirm kar deta hun")
      .replace(/\bconfirm\s+karwa\s+deta\s+hoon\b/gi, "confirm kar deta hun")
      .replace(/\bkarwa\s+deta\s+hun\b/gi, "kar deta hun")
      .replace(/\bkarwa\s+deta\s+hoon\b/gi, "kar deta hun");
  }
  return text;
}

export function applyResponseStrategy({
  reply,
  strategyDecision,
  userMessage,
  lastAssistantMessage,
  conversationState = {},
  variationIndex = null,
  random,
  now = Date.now(),
} = {}) {
  const decision = strategyDecision || { strategy: "no_followup", reason: "missing_strategy" };
  let finalReply = enforceToneStyle(reply);
  const events = [];

  if (decision.strategy === "answer_then_guide") {
    const questionType = "duration";
    const repeated =
      wasAskedRecently(conversationState, questionType, now) ||
      asksOrStatesDuration(lastAssistantMessage);
    if (repeated) {
      events.push({
        type: "followup_blocked_due_to_repetition",
        questionType,
      });
      return { reply: finalReply, events };
    }
    const variation = selectVariation("duration_question", { index: variationIndex, random });
    finalReply = `${finalReply}\n${variation.text}`.trim();
    events.push({ type: "variation_applied", ...variation });
    events.push({ type: "followup_added", questionType });
    return { reply: finalReply, events };
  }

  if (decision.strategy === "ask_clarification") {
    const lastQuestionType = recentQuestionType(conversationState, lastAssistantMessage);
    if (lastQuestionType === "duration") {
      const variation = selectVariation("duration_question", { index: variationIndex, random });
      events.push({ type: "variation_applied", ...variation });
      return { reply: variation.text, events };
    }
    return {
      reply: "Kis cheez ka confirm karna tha?",
      events,
    };
  }

  if (decision.strategy === "no_followup" || decision.strategy === "answer_only") {
    events.push({
      type: "no_followup_decision",
      strategy: decision.strategy,
    });
    return { reply: finalReply, events };
  }

  return { reply: finalReply, events };
}

export const _test = {
  isCasualReplyText,
  showsProceedIntent,
  asksOrStatesDuration,
  wasAskedRecently,
};
