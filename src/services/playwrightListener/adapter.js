/**
 * Map WhatsApp Web DOM snippets → minimal shape for the pipeline bridge.
 * @param {{ id?: string | null, text: string, timeHint?: string, groupName?: string, senderName?: string }} raw
 * @returns {{ text: string, senderName: string, timestamp: string | null, groupName: string } | null}
 */

/** Short system / meta lines only (avoid flagging normal chat containing “left”, etc.). */
const SYSTEM_LINE =
  /^(?:[\u200e\u200f\s]*)(?:.*\b(joined|left)\s+(?:this group|the group)\b|You (?:turned on|turned off) disappearing messages|Messages and calls are secured|Waiting for this message\.? This may take a few moments\.?|You added |You removed |changed the subject to|changed this group's icon|pinned a message)/i;

export function adaptPlaywrightDomMessage(raw) {
  const blob = String(raw?.text ?? "").trim();
  if (!blob) {
    return null;
  }

  const groupNameRaw = String(raw?.groupName ?? "").trim();
  const groupName = groupNameRaw || "unknown-group";

  const domSender = String(raw?.senderName ?? "").trim();

  const timestamp =
    raw?.timeHint && String(raw.timeHint).trim()
      ? String(raw.timeHint).trim()
      : null;

  if (domSender) {
    const text = blob;
    if (!text || text.length < 1) {
      return null;
    }
    if (text.length < 200 && SYSTEM_LINE.test(text)) {
      return null;
    }
    return {
      text,
      senderName: domSender,
      timestamp,
      groupName,
    };
  }

  const lines = blob
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let senderName = "unknown";
  let body = blob;

  if (lines.length >= 2) {
    senderName = lines[0];
    const rest = lines.slice(1);
    const head = rest[0] ?? "";
    const timeLike =
      /^(\d{1,2}:\d{2}\s*(?:AM|PM)?|Yesterday|Today|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(
        head
      ) || /^\d{1,2}:\d{2}$/.test(head);
    if (timeLike && rest.length > 1) {
      body = rest.slice(1).join("\n");
    } else {
      body = rest.join("\n");
    }
  }

  const text = (body.trim() || blob).trim();
  if (!text || text.length < 2) {
    return null;
  }

  if (text.length < 200 && SYSTEM_LINE.test(text)) {
    return null;
  }

  return {
    text,
    senderName: senderName.trim() || "unknown",
    timestamp,
    groupName,
  };
}
