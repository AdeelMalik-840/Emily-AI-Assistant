/**
 * Participant + memory policy facts for canonical context.
 */

/**
 * @param {import("../contracts/turnContextInput.js").TurnContextInput | null | undefined} turnContextInput
 */
export function resolveParticipantFacts(turnContextInput) {
  const input = turnContextInput ?? null;
  return {
    participant: {
      key: input?.participantKey ?? null,
      identity: input?.participantIdentity ?? "unresolved",
      memoryAllowed: input?.memoryAllowed === true,
    },
    sourceEvidence: {
      participant: {
        participantKey: input?.participantKey ?? null,
        participantIdentity: input?.participantIdentity ?? null,
        memoryAllowed: input?.memoryAllowed === true,
        isGroup: input?.chatType === "group",
      },
    },
  };
}
