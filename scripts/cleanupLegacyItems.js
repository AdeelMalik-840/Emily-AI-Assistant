import admin from "firebase-admin";
import db from "../src/config/firebase.js";

const isDryRun = process.argv.includes("--dry-run");

/**
 * @param {Record<string, unknown>} item
 * @param {string} docId
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateMigratedItem(item, docId) {
  const id = String(item?.id ?? "").trim();
  const displayLabel = String(item?.displayLabel ?? "").trim();
  const normalizedLabel = String(item?.normalizedLabel ?? "").trim();

  if (!id || id !== docId) {
    return { ok: false, reason: "id_mismatch" };
  }
  if (!displayLabel) {
    return { ok: false, reason: "missing_displayLabel" };
  }
  if (!normalizedLabel) {
    return { ok: false, reason: "missing_normalizedLabel" };
  }
  return { ok: true };
}

async function cleanupLegacyItems() {
  /** @type {{ checked: number, cleaned: number, skipped: number, failedValidation: number, dryRunWouldClean: number, failedVerification: number }} */
  const stats = {
    checked: 0,
    cleaned: 0,
    skipped: 0,
    failedValidation: 0,
    dryRunWouldClean: 0,
    failedVerification: 0,
  };

  const businessesSnap = await db.collection("businesses").get();
  console.log("🚀 Starting legacy cleanup", {
    businesses: businessesSnap.size,
    mode: isDryRun ? "dry-run" : "live",
  });

  for (const bizDoc of businessesSnap.docs) {
    const businessId = bizDoc.id;
    const bizData = bizDoc.data() ?? {};
    stats.checked += 1;

    try {
      if (!("items" in bizData) && !("vehicles" in bizData)) {
        stats.skipped += 1;
        console.log("⏭️ No legacy fields present, skipping", { businessId });
        continue;
      }

      const itemsSnap = await db
        .collection("businesses")
        .doc(businessId)
        .collection("items")
        .get();

      if (itemsSnap.empty) {
        stats.skipped += 1;
        console.log("⚠️ Skipping (no migrated items)", { businessId });
        continue;
      }

      let valid = true;
      for (const itemDoc of itemsSnap.docs) {
        const itemData =
          itemDoc.data() && typeof itemDoc.data() === "object"
            ? /** @type {Record<string, unknown>} */ (itemDoc.data())
            : {};
        const check = validateMigratedItem(itemData, itemDoc.id);
        if (!check.ok) {
          valid = false;
          console.error("❌ Validation failed", {
            businessId,
            docId: itemDoc.id,
            reason: check.reason ?? "unknown",
          });
          break;
        }
      }

      if (!valid) {
        stats.failedValidation += 1;
        continue;
      }

      if (isDryRun) {
        stats.dryRunWouldClean += 1;
        console.log("🧪 DRY RUN: would clean business", { businessId });
        continue;
      }

      await db.collection("businesses").doc(businessId).update({
        items: admin.firestore.FieldValue.delete(),
        vehicles: admin.firestore.FieldValue.delete(),
      });

      // Add a tiny delay between writes to avoid burst pressure.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const updatedSnap = await db.collection("businesses").doc(businessId).get();
      const updatedData = updatedSnap.data() ?? {};
      if ("items" in updatedData || "vehicles" in updatedData) {
        stats.failedVerification += 1;
        console.error("❌ Cleanup verification failed", { businessId });
        continue;
      }

      stats.cleaned += 1;
      console.log("🧹 Cleaned legacy fields", { businessId });
    } catch (err) {
      stats.skipped += 1;
      console.error("⚠️ Error while processing business, skipping", {
        businessId,
        error: err?.message || String(err),
      });
    }
  }

  console.log("✅ Cleanup summary", {
    totalBusinessesChecked: stats.checked,
    totalCleaned: stats.cleaned,
    totalSkipped: stats.skipped,
    totalFailedValidation: stats.failedValidation,
    totalDryRunWouldClean: stats.dryRunWouldClean,
    totalFailedVerification: stats.failedVerification,
  });
}

cleanupLegacyItems().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exitCode = 1;
});
