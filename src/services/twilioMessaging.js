console.log("TWILIO SID:", process.env.TWILIO_ACCOUNT_SID);
console.log("TWILIO TOKEN:", process.env.TWILIO_AUTH_TOKEN);

import twilio from "twilio";

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(sid, token);
}

/**
 * Twilio outbound message (provider-specific). Not part of the assistant brain.
 */
export async function sendWhatsAppReply(to, body) {
  try {
    const from = process.env.TWILIO_WHATSAPP_FROM;

    console.log("FROM:", from);
    console.log("TO:", to);
    console.log("BODY:", body);

    const client = getClient();

    const response = await client.messages.create({
      from,
      to,
      body,
    });

    console.log("✅ Twilio sent:", response.sid);
  } catch (error) {
    console.error("❌ Twilio ERROR:", error.message);
    console.error(error);
  }
}