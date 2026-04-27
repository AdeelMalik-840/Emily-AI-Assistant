import db from "../src/config/firebase.js";

async function validate() {
  const businesses = await db.collection("businesses").get();
  let warnings = 0;
  for (const biz of businesses.docs) {
    const items = await biz.ref.collection("items").get();
    for (const doc of items.docs) {
      const item = doc.data() ?? {};
      if (!item.id || String(item.id).trim() !== doc.id) {
        console.warn("⚠️ bad id", { businessId: biz.id, docId: doc.id, id: item.id ?? null });
        warnings += 1;
      }
      if (!String(item.displayLabel ?? "").trim()) {
        console.warn("⚠️ missing label", { businessId: biz.id, docId: doc.id });
        warnings += 1;
      }
      if (!String(item.normalizedLabel ?? "").trim()) {
        console.warn("⚠️ missing normalizedLabel", { businessId: biz.id, docId: doc.id });
        warnings += 1;
      }
    }
  }
  console.log("✅ Validation complete", { warnings });
}

validate().catch((err) => {
  console.error("Validation failed:", err);
  process.exitCode = 1;
});
