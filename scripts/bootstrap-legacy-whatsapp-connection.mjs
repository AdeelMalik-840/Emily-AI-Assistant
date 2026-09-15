import db from "../src/config/firebase.js";
import { bootstrapLegacyWhatsAppBusiness } from "../src/services/legacyWhatsAppBootstrap.js";

const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run");

if (apply && dryRun) {
  console.error("Pass only one of --apply or --dry-run.");
  process.exit(2);
}

if (!apply && !dryRun) {
  console.error("Refusing to write without --apply. Use --dry-run to print the Cloud + group-scope plan.");
  process.exit(2);
}

const result = await bootstrapLegacyWhatsAppBusiness(db, { dryRun });
console.log(JSON.stringify(result));
if (result?.groupScope?.errorCode === "LEGACY_GROUP_SCOPE_REQUIRES_OPERATOR_INPUT") {
  process.exitCode = 3;
}
