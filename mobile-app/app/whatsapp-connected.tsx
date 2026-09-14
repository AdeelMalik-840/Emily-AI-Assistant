import { Redirect } from "expo-router";

/**
 * Handles Meta OAuth return URL (e.g. emily://whatsapp-connected?status=success).
 * Firestore is already updated by the server callback; just land on Home.
 */
export default function WhatsAppConnectedRedirect() {
  return <Redirect href="/(tabs)" />;
}
