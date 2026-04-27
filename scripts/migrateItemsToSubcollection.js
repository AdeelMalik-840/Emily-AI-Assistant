import admin from "firebase-admin";
import db from "../src/config/firebase.js";
import crypto from "node:crypto";
const isDryRun = process.argv.includes("--dry-run");

/**
 * @param {unknown} val
 */
function clean(val) {
  return typeof val === "string" ? val.trim() : "";
}

/**
 * Normalize labels for deterministic identity across formatting variants.
 * @param {string} str
 */
function normalizeLabel(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Keep deterministic ID base safe and readable.
 * @param {string} str
 */
function safeBaseName(str) {
  return String(str ?? "").replace(/[^a-z0-9]+/gi, " ").trim() || "item";
}

/**
 * Bounded, human-readable deterministic Firestore doc id.
 * @param {string} normalizedLabel
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
 * @returns {unknown[]}
 */
function extractBusinessItems(bizData) {
  const candidates = [
    bizData.items,
    bizData.vehicles,
    bizData.products,
    bizData.services,
    bizData.packages,
    bizData.menu?.items,
    bizData.catalog?.items,
    bizData.businessProfile?.items,
    bizData.businessProfile?.vehicles,
    bizData.businessProfile?.products,
    bizData.businessProfile?.services,
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }

  return [];
}

/**
 * Runtime-safe businessProfile object for nested fallbacks.
 * @param {Record<string, unknown>} bizData
 * @returns {Record<string, unknown>}
 */
function getBusinessProfileObject(bizData) {
  const bp = bizData.businessProfile;
  if (bp && typeof bp === "object" && !Array.isArray(bp)) {
    return /** @type {Record<string, unknown>} */ (bp);
  }
  return {};
}

async function migrate() {
  const businesses = await db.collection("businesses").get();
  console.log(`Found businesses: ${businesses.size}`);

  for (const bizDoc of businesses.docs) {
    const businessId = bizDoc.id;
    const bizData = bizDoc.data() ?? {};
    const businessProfile = getBusinessProfileObject(bizData);
    const itemsArray = extractBusinessItems(bizData);

    const itemsColl = db
      .collection("businesses")
      .doc(businessId)
      .collection("items");

    if (!itemsArray.length) {
      console.log("⚠️ No items found:", businessId, Object.keys(bizData));
      continue;
    }

    console.log("🔄 Migrating:", businessId, itemsArray.length);

    for (const raw of itemsArray) {
      const item =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? /** @type {Record<string, unknown>} */ (raw)
          : {};

      const baseName =
        clean(item.name) ||
        clean(item.title) ||
        clean(item.serviceName) ||
        clean(bizData.businessName) ||
        clean(businessProfile.businessName) ||
        "Item";
      const color = clean(item.color);
      const displayLabel =
        clean(item.displayLabel) || `${baseName}${color ? ` (${color})` : ""}`;
      const normalizedLabel = normalizeLabel(displayLabel);
      if (!normalizedLabel) {
        console.log("⚠️ Skipping invalid item:", item);
        continue;
      }

      const itemId = clean(item.id) || null;
      if (itemId) {
        const existingDoc = await itemsColl.doc(itemId).get();
        if (existingDoc.exists) {
          console.log("⏭ Skipping existing item:", itemId);
          continue;
        }
      }

      const docId = generateDocId(normalizedLabel);
      const itemRef = itemsColl.doc(docId);
      const existingDoc = await itemRef.get();
      if (existingDoc.exists) {
        console.log("⏭ Skipping existing item:", displayLabel);
        continue;
      }

      if (isDryRun) {
        console.log("🧪 DRY RUN:", displayLabel);
        continue;
      }

      await itemRef.set({
        ...item,
        id: itemRef.id,
        name: baseName,
        color,
        displayLabel,
        normalizedLabel,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("✅ Migrated:", displayLabel);
    }
  }

  console.log("🎉 Migration complete");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});

