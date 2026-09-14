import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import {
  cancelLinkAttempt,
  disconnectWhatsAppConnection,
  getConnectionStatus,
  getLinkAttemptStatus,
  reconnectWhatsApp,
  startLinkAttempt,
  type WhatsAppConnection,
} from "@/services/whatsappConnection";
import { parseAndValidateManualWhatsAppPhone } from "@/utils/validateManualWhatsAppPhone";

const LINK_ATTEMPT_POLL_MS = 2500;
const CONNECTION_POLL_MS = 3000;

export type WhatsAppConnectionPhase =
  | { kind: "loading" }
  | { kind: "phone_entry" }
  | { kind: "preparing" }
  | { kind: "code_ready"; linkingCode: string }
  | { kind: "setting_up" }
  | { kind: "ready"; displayPhoneNumber: string | null }
  | { kind: "reconnect_required" }
  | { kind: "error" };

function attemptStorageKey(businessId: string): string {
  return `emily.whatsapp.activeLinkAttemptId.${businessId}`;
}

/**
 * Drives the Connect WhatsApp UX against the backend-authoritative
 * whatsapp_connections / whatsapp_link_attempts model. The frontend never
 * decides "connected" on its own -- it only reflects what the server
 * reports (overallStatus === "ready" requires group AND dm connected).
 */
export function useWhatsAppConnection(businessId: string | null) {
  const [phase, setPhase] = useState<WhatsAppConnectionPhase>({
    kind: "loading",
  });
  const [connection, setConnection] = useState<WhatsAppConnection | null>(
    null
  );

  const attemptIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const businessIdRef = useRef(businessId);
  businessIdRef.current = businessId;

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const persistAttemptId = useCallback(async (attemptId: string | null) => {
    attemptIdRef.current = attemptId;
    const uid = businessIdRef.current;
    if (!uid) return;
    try {
      if (attemptId) {
        await AsyncStorage.setItem(attemptStorageKey(uid), attemptId);
      } else {
        await AsyncStorage.removeItem(attemptStorageKey(uid));
      }
    } catch {
      // Best-effort only; losing this cache just means the app falls back
      // to the plain connection-status view after a kill+reopen mid-link.
    }
  }, []);

  const applyConnection = useCallback((next: WhatsAppConnection | null) => {
    if (!mountedRef.current) return;
    setConnection(next);
    if (!next) return "not_connected" as const;
    return next.overallStatus;
  }, []);

  const pollConnectionUntilReady = useCallback(() => {
    clearPollTimer();
    const tick = async () => {
      try {
        const next = await getConnectionStatus();
        if (!mountedRef.current) return;
        const status = applyConnection(next);
        if (status === "ready") {
          await persistAttemptId(null);
          setPhase({
            kind: "ready",
            displayPhoneNumber: next?.dm.displayPhoneNumber ?? null,
          });
          return;
        }
        if (status === "reconnect_required") {
          await persistAttemptId(null);
          setPhase({ kind: "reconnect_required" });
          return;
        }
        setPhase({ kind: "setting_up" });
        pollTimerRef.current = setTimeout(tick, CONNECTION_POLL_MS);
      } catch {
        if (!mountedRef.current) return;
        pollTimerRef.current = setTimeout(tick, CONNECTION_POLL_MS);
      }
    };
    void tick();
  }, [applyConnection, clearPollTimer, persistAttemptId]);

  const pollLinkAttempt = useCallback(
    (attemptId: string) => {
      clearPollTimer();
      const tick = async () => {
        try {
          const attempt = await getLinkAttemptStatus(attemptId);
          if (!mountedRef.current) return;
          if (!attempt) {
            await persistAttemptId(null);
            setPhase({ kind: "error" });
            return;
          }
          if (attempt.status === "preparing") {
            setPhase({ kind: "preparing" });
            pollTimerRef.current = setTimeout(tick, LINK_ATTEMPT_POLL_MS);
            return;
          }
          if (attempt.status === "code_ready" || attempt.status === "waiting") {
            if (attempt.linkingCode) {
              setPhase({
                kind: "code_ready",
                linkingCode: attempt.linkingCode,
              });
            } else {
              setPhase({ kind: "setting_up" });
            }
            pollTimerRef.current = setTimeout(tick, LINK_ATTEMPT_POLL_MS);
            return;
          }
          if (attempt.status === "connected") {
            setPhase({ kind: "setting_up" });
            pollConnectionUntilReady();
            return;
          }
          // failed | expired | cancelled
          await persistAttemptId(null);
          setPhase({ kind: "error" });
        } catch {
          if (!mountedRef.current) return;
          pollTimerRef.current = setTimeout(tick, LINK_ATTEMPT_POLL_MS);
        }
      };
      void tick();
    },
    [clearPollTimer, persistAttemptId, pollConnectionUntilReady]
  );

  const refresh = useCallback(async () => {
    if (!businessIdRef.current) {
      setPhase({ kind: "phone_entry" });
      return;
    }
    try {
      const next = await getConnectionStatus();
      if (!mountedRef.current) return;
      const status = applyConnection(next);

      if (status === "ready") {
        await persistAttemptId(null);
        setPhase({
          kind: "ready",
          displayPhoneNumber: next?.dm.displayPhoneNumber ?? null,
        });
        return;
      }
      if (status === "reconnect_required") {
        await persistAttemptId(null);
        setPhase({ kind: "reconnect_required" });
        return;
      }

      const cachedAttemptId = await AsyncStorage.getItem(
        attemptStorageKey(businessIdRef.current)
      ).catch(() => null);
      if (cachedAttemptId) {
        attemptIdRef.current = cachedAttemptId;
        pollLinkAttempt(cachedAttemptId);
        return;
      }

      if (status === "connecting") {
        setPhase({ kind: "setting_up" });
        pollConnectionUntilReady();
        return;
      }

      setPhase({ kind: "phone_entry" });
    } catch {
      if (!mountedRef.current) return;
      setPhase({ kind: "phone_entry" });
    }
  }, [applyConnection, persistAttemptId, pollConnectionUntilReady, pollLinkAttempt]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      clearPollTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (phase.kind === "code_ready" || phase.kind === "preparing") {
        if (attemptIdRef.current) pollLinkAttempt(attemptIdRef.current);
      } else if (phase.kind === "setting_up") {
        pollConnectionUntilReady();
      }
    });
    return () => sub.remove();
  }, [phase.kind, pollLinkAttempt, pollConnectionUntilReady]);

  const submitPhone = useCallback(
    async (rawPhone: string) => {
      const parsed = parseAndValidateManualWhatsAppPhone(rawPhone);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      setPhase({ kind: "preparing" });
      try {
        const attempt = await startLinkAttempt(parsed.phone);
        await persistAttemptId(attempt.attemptId);
        pollLinkAttempt(attempt.attemptId);
      } catch (err) {
        setPhase({ kind: "phone_entry" });
        throw err;
      }
    },
    [persistAttemptId, pollLinkAttempt]
  );

  const cancelLinking = useCallback(async () => {
    clearPollTimer();
    const attemptId = attemptIdRef.current;
    await persistAttemptId(null);
    setPhase({ kind: "phone_entry" });
    if (attemptId) {
      await cancelLinkAttempt(attemptId).catch(() => {});
    }
  }, [clearPollTimer, persistAttemptId]);

  const retryAfterError = useCallback(() => {
    void refresh();
  }, [refresh]);

  const reconnect = useCallback(
    async (rawPhone: string) => {
      const parsed = parseAndValidateManualWhatsAppPhone(rawPhone);
      if (!parsed.ok) {
        throw new Error(parsed.error);
      }
      setPhase({ kind: "preparing" });
      try {
        const attempt = await reconnectWhatsApp(parsed.phone);
        await persistAttemptId(attempt.attemptId);
        pollLinkAttempt(attempt.attemptId);
      } catch (err) {
        setPhase({ kind: "reconnect_required" });
        throw err;
      }
    },
    [persistAttemptId, pollLinkAttempt]
  );

  const disconnect = useCallback(async () => {
    clearPollTimer();
    await disconnectWhatsAppConnection();
    await persistAttemptId(null);
    setConnection(null);
    setPhase({ kind: "phone_entry" });
  }, [clearPollTimer, persistAttemptId]);

  return {
    phase,
    connection,
    submitPhone,
    cancelLinking,
    retryAfterError,
    reconnect,
    disconnect,
    refresh,
  };
}
