import admin from "firebase-admin";

import db from "../src/config/firebase.js";

function clean(value) {
  return String(value ?? "").trim();
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function pickFields(data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    status: d.status ?? null,
    approvalCustomerNotificationStatus: d.approvalCustomerNotificationStatus ?? null,
    approvalCustomerNotificationTerminalFailure:
      d.approvalCustomerNotificationTerminalFailure ?? null,
    approvalCustomerNotificationRetryable: d.approvalCustomerNotificationRetryable ?? null,
    dmOpened: d.dmOpened ?? null,
    dmMessageSent: d.dmMessageSent ?? null,
    playwrightReplyPrivateEligible: d.playwrightReplyPrivateEligible ?? null,
    dmPlaywrightChatKey: d.dmPlaywrightChatKey ?? null,
    dmChatTitle: d.dmChatTitle ?? null,
  };
}

async function getDocIfExists(ref) {
  const snap = await ref.get();
  if (!snap.exists) return { exists: false, ref, snap: null, data: null };
  return { exists: true, ref, snap, data: snap.data() || {} };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = hasFlag(argv, "--write");

  const bookingId = "O7hHS624naO5CXtMZVZq";
  const businessId = "afWvEVJnssbbp6Jt2GIu23uCrTF2";

  if (!bookingId || !businessId) {
    console.error("Missing bookingId/businessId.");
    process.exitCode = 1;
    return;
  }

  const rootRef = db.collection("bookings").doc(bookingId);
  const businessRef = db
    .collection("businesses")
    .doc(businessId)
    .collection("bookings")
    .doc(bookingId);

  const [rootDoc, businessDoc] = await Promise.all([
    getDocIfExists(rootRef),
    getDocIfExists(businessRef),
  ]);

  if (!rootDoc.exists && !businessDoc.exists) {
    console.log(
      `Booking not found at either path for bookingId=${bookingId}. Nothing to do.`
    );
    return;
  }

  const target =
    businessDoc.exists && rootDoc.exists
      ? "businesses/{businessId}/bookings/{bookingId} (both existed; using business path)"
      : businessDoc.exists
        ? "businesses/{businessId}/bookings/{bookingId}"
        : "bookings/{bookingId}";

  if (businessDoc.exists && rootDoc.exists) {
    console.warn(
      `Warning: bookingId=${bookingId} exists at BOTH paths. This script will update ONLY the business subcollection path.`
    );
  }

  const chosen = businessDoc.exists ? businessDoc : rootDoc;

  console.log("=== Cleanup target ===");
  console.log("bookingId:", bookingId);
  console.log("businessId:", businessId);
  console.log("path:", target);
  console.log("mode:", write ? "WRITE" : "DRY_RUN");
  console.log("");

  console.log("=== Current values (before) ===");
  console.log(JSON.stringify(pickFields(chosen.data), null, 2));
  console.log("");

  const patch = {
    approvalCustomerNotificationStatus: "failed",
    approvalCustomerNotificationTerminalFailure: true,
    approvalCustomerNotificationRetryable: false,
    dmOpened: false,
    dmMessageSent: false,
    playwrightReplyPrivateEligible: false,
    dmPlaywrightChatKey: null,
    dmChatTitle: null,
    cleanupReason: "manual_cleanup_stuck_reply_private_terminal_failed",
    cleanupAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  console.log("=== Patch to apply ===");
  console.log(JSON.stringify(patch, null, 2));
  console.log("");

  if (!write) {
    console.log("Dry-run mode (default): no writes performed.");
    console.log("Re-run with: node scripts/cleanup-stuck-reply-private-booking.mjs --write");
    return;
  }

  console.log("Writing patch...");
  await chosen.ref.update(patch);
  console.log("Write complete.");

  const updatedSnap = await chosen.ref.get();
  const updated = updatedSnap.exists ? updatedSnap.data() || {} : {};

  console.log("");
  console.log("=== Updated values (after) ===");
  console.log(JSON.stringify(pickFields(updated), null, 2));
}

main().catch((err) => {
  console.error("Cleanup script failed:", clean(err?.message ?? err) || err);
  process.exitCode = 1;
});

