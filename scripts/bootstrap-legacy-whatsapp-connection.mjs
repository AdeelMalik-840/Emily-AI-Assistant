import db from "../src/config/firebase.js";
import { bootstrapLegacyWhatsAppBusiness } from "../src/services/legacyWhatsAppBootstrap.js";

if (!process.argv.includes("--apply")) {
  console.error("Refusing to write without --apply. This script is operator-controlled and must not be run automatically.");
  process.exit(2);
}

const result = await bootstrapLegacyWhatsAppBusiness(db);
console.log(JSON.stringify(result));
