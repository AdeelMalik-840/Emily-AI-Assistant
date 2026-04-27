import admin from "firebase-admin";
import db from "../src/config/firebase.js";
import crypto from "node:crypto";

const isDryRun = process.argv.includes("--dry-run");

/**
 * @param {unknown} val
 * @returns {string}
 */
function clean(val) {
  return typeof val === "string" ? val.trim() : "";
}

/**
 * @param {string} str
 * @returns {string}
 */
function normalizeLabel(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param {string} str
 * @returns {string}
 */
function safeBaseName(str) {
  return String(str ?? "").replace(/[^a-z0-9]+/gi, " ").trim() || "item";
}

/**
 * @param {string} normalizedLabel
 * @returns {string}
 */
function generateDocId(normalizedLabel) {
  const shortLabel = safeBaseName(normalizedLabel)
    .replace(/\s+/g, "_")
    .slice(0, 50);
  const hash = crypto
    .createHash("md5")
    .update(String(normalizedLabel ?? ""))
    .digest("hex")
    .slice(0, 8);
  return `${shortLabel}_${hash}`;
}

/**
 * @param {Record<string, unknown>} bizData
 * @param {Record<string, unknown>} item
 */
function deriveDisplayLabel(bizData, item) {
  const baseName =
    clean(item.name) || clean(item.title) || clean(item.serviceName) || clean(bizData.businessName) || "Item";
  const color = clean(item.color);
  return clean(item.displayLabel) || `${baseName}${color ? ` (${color})` : ""}`;
}

async function run() {
  /** @type {{ checked: number, brokenDetected: number, fixed: number, skipped: number, failed: number }} */
  const stats = {
    checked: 0,
    brokenDetected: 0,
    fixed: 0,
    skipped: 0,
    failed: 0,
  };

  const businesses = await db.collection("businesses").get();
  console.log("🚀 Starting missing-subcollection fixer", {
    businesses: businesses.size,
    mode: isDryRun ? "dry-run" : "live",
  });

  for (const bizDoc of businesses.docs) {
    const businessId = bizDoc.id;
    const bizData =
      bizDoc.data() && typeof bizDoc.data() === "object"
        ? /** @type {Record<string, unknown>} */ (bizDoc.data())
        : {};
    console.log("🔎 FULL DOC", {
      businessId,
      keys: Object.keys(bizData),
      hasBusinessProfile: !!bizData.businessProfile,
      businessProfileKeys: bizData.businessProfile
        ? Object.keys(
            /** @type {Record<string, unknown>} */ (bizData.businessProfile)
          )
        : null,
      itemsRoot: bizData.items,
      itemsNested: bizData.businessProfile?.items,
    });
    stats.checked += 1;

    try {
      const rawItems = bizData.items ?? bizData.businessProfile?.items ?? null;
      /** @type {unknown[]} */
      let legacyItems = [];
      if (Array.isArray(rawItems)) {
        legacyItems = rawItems;
      } else if (rawItems && typeof rawItems === "object") {
        // Handle Firestore map/object shape by normalizing values to an array.
        legacyItems = Object.values(rawItems);
      }
      const hasLegacyItems = legacyItems.length > 0;
      const itemsColl = db.collection("businesses").doc(businessId).collection("items");
      const subSnap = await itemsColl.get();
      const subcollectionCount = subSnap.size;
      const legacyCount = legacyItems.length;
      const isFullyMigrated = subcollectionCount >= legacyCount;

      if (!hasLegacyItems || isFullyMigrated) {
        stats.skipped += 1;
        continue;
      }

      stats.brokenDetected += 1;
      console.log("🛠 Fixing broken business:", businessId);

      /** @type {Array<{ docId: string, payload: Record<string, unknown>, label: string }>} */
      const pendingWrites = [];
      const seenDocIds = new Set();
      let collisionFound = false;

      for (const raw of legacyItems) {
        const item =
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? /** @type {Record<string, unknown>} */ (raw)
            : {};
        const displayLabel = deriveDisplayLabel(bizData, item);
        const normalized = normalizeLabel(displayLabel);
        if (!normalized) {
          console.error("❌ Failure: invalid item label, skipping business", {
            businessId,
            item,
          });
          collisionFound = true;
          break;
        }

        const docId = generateDocId(normalized);
        if (seenDocIds.has(docId)) {
          console.error("❌ Failure: docId collision in legacy array, skipping business", {
            businessId,
            docId,
            displayLabel,
          });
          collisionFound = true;
          break;
        }
        seenDocIds.add(docId);

        pendingWrites.push({
          docId,
          label: displayLabel,
          payload: {
            ...item,
            id: docId,
            displayLabel,
            normalizedLabel: normalized,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        });
      }

      if (collisionFound) {
        stats.failed += 1;
        console.error("❌ Failure → DO NOT DELETE ARRAY", { businessId });
        continue;
      }

      if (isDryRun) {
        console.log("🧪 DRY RUN: would migrate business", {
          businessId,
          items: pendingWrites.length,
        });
        for (const w of pendingWrites) {
          console.log("🧪 DRY RUN: would migrate item", {
            businessId,
            label: w.label,
            docId: w.docId,
          });
        }
        continue;
      }

      for (const w of pendingWrites) {
        await itemsColl.doc(w.docId).set(w.payload);
        console.log("✅ Migrated item:", w.label);
      }

      const verifySnap = await itemsColl.get();
      if (verifySnap.size !== pendingWrites.length) {
        stats.failed += 1;
        console.error("❌ Verification failed → DO NOT DELETE ARRAY", {
          businessId,
          expected: pendingWrites.length,
          actual: verifySnap.size,
        });
        continue;
      }

      await db.collection("businesses").doc(businessId).update({
        items: admin.firestore.FieldValue.delete(),
      });
      console.log("🧹 Removed legacy array", { businessId });
      stats.fixed += 1;
    } catch (err) {
      stats.failed += 1;
      console.error("❌ Error while fixing business", {
        businessId,
        error: err?.message || String(err),
      });
    }
  }

  console.log("✅ Fixer summary", {
    totalBusinessesChecked: stats.checked,
    totalBrokenDetected: stats.brokenDetected,
    totalFixed: stats.fixed,
    totalSkipped: stats.skipped,
    totalFailed: stats.failed,
  });
}

run().catch((err) => {
  console.error("Fixer failed:", err);
  process.exitCode = 1;
});
