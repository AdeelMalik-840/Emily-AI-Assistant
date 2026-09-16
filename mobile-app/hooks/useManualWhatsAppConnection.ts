/**
 * Investor-demo WhatsApp status: Firestore businesses/{uid} + 6c0f46d
 * POST /api/whatsapp/manual-connect and /disconnect.
 * Does not poll /api/whatsapp/connection or link-attempt routes.
 */
import { doc, onSnapshot } from "firebase/firestore";
import { useCallback, useEffect, useState } from "react";

import { db } from "@/firebase";
import {
  disconnectWhatsApp,
  parseBusinessWhatsAppDoc,
  submitManualWhatsAppConnect,
  type DemoWhatsAppState,
  type DemoWhatsAppStatus,
} from "@/services/whatsappConnect";

export function useManualWhatsAppConnection(businessId: string | null) {
  const [state, setState] = useState<DemoWhatsAppState>({
    status: "disconnected",
    phone: null,
  });
  const [loading, setLoading] = useState(Boolean(businessId));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!businessId) {
      setState({ status: "disconnected", phone: null });
      setLoading(false);
      return;
    }
    setLoading(true);
    const ref = doc(db, "businesses", businessId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setState(
          parseBusinessWhatsAppDoc(
            snap.exists() ? (snap.data() as Record<string, unknown>) : null
          )
        );
        setLoading(false);
      },
      () => {
        setState({ status: "disconnected", phone: null });
        setLoading(false);
      }
    );
    return unsub;
  }, [businessId]);

  const submitPhone = useCallback(async (rawPhone: string) => {
    setSubmitting(true);
    try {
      await submitManualWhatsAppConnect(rawPhone);
    } finally {
      setSubmitting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setSubmitting(true);
    try {
      await disconnectWhatsApp();
    } finally {
      setSubmitting(false);
    }
  }, []);

  return {
    status: state.status as DemoWhatsAppStatus,
    phone: state.phone,
    loading,
    submitting,
    submitPhone,
    disconnect,
  };
}
