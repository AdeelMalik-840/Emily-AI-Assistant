import crypto from "node:crypto";
import admin from "firebase-admin";

const FieldValue = admin.firestore.FieldValue;

export async function createConnectState(db, ownerUid) {
  const uid = String(ownerUid ?? "").trim();
  if (!uid) throw new Error("ownerUid required");
  const state = crypto.randomBytes(24).toString("hex");
  await db.collection("whatsapp_connect_states").doc(state).set({
    uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return state;
}

/**
 * @returns {Promise<string | null>} owner Firebase uid
 */
export async function consumeConnectState(db, state) {
  const s = String(state ?? "").trim();
  if (!s) return null;
  const ref = db.collection("whatsapp_connect_states").doc(s);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const uid = snap.data()?.uid;
  await ref.delete();
  return typeof uid === "string" && uid.trim() !== "" ? uid.trim() : null;
}
