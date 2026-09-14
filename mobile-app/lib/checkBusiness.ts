import { doc, getDoc } from "firebase/firestore";

import { db } from "@/firebase";

/**
 * Whether the user has completed onboarding business profile (Firestore `businesses/{userId}`).
 * Matches `useBusinessProfileReady` / onboarding save shape.
 */
export async function checkBusinessProfile(userId: string): Promise<boolean> {
  try {
    const ref = doc(db, "businesses", userId);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      return false;
    }

    const data = snap.data();
    return Boolean(data?.businessName ?? data?.business_name);
  } catch (e) {
    console.log("❌ checkBusinessProfile error:", e);
    return false;
  }
}
