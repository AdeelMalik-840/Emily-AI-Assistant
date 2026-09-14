import express from "express";
import { cancelOwnedLinkAttempt } from "./whatsappLinkAttemptService.js";
import { disableCloudBusinessRoute } from "./whatsappCloudRouteRegistry.js";
import { getWhatsAppConnection, initializeWhatsAppConnection, sanitizeWhatsAppConnection, updateGroupConnection } from "./whatsappConnectionRegistry.js";

export function createWhatsAppConnectionRouter({ db, verifyIdToken, workerManager }) {
  if (!db || typeof verifyIdToken !== "function") throw new Error("CONNECTION_API_DEPENDENCIES_REQUIRED");
  const router = express.Router();
  router.use(async (req, res, next) => {
    const raw = String(req.headers.authorization ?? "");
    if (!raw.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded = await verifyIdToken(raw.slice(7));
      if (!decoded?.uid) return res.status(401).json({ error: "Unauthorized" });
      req.connectionBusinessId = decoded.uid;
      return next();
    } catch { return res.status(401).json({ error: "Unauthorized" }); }
  });

  router.get("/connection", async (req, res) => {
    try {
      const value = await getWhatsAppConnection(db, req.connectionBusinessId) || await initializeWhatsAppConnection(db, req.connectionBusinessId);
      return res.json({ connection: sanitizeWhatsAppConnection(value) });
    } catch (error) { return res.status(error?.message === "BUSINESS_NOT_FOUND" ? 404 : 500).json({ error: error?.message || "Server error" }); }
  });

  router.post("/link-attempt", async (req, res) => {
    if (!workerManager) return res.status(503).json({ error: "Connection manager unavailable" });
    try {
      await initializeWhatsAppConnection(db, req.connectionBusinessId);
      const attempt = await workerManager.startLink(req.connectionBusinessId, req.body?.phone);
      return res.status(201).json({ attempt });
    } catch (error) {
      const bad = ["INVALID_PHONE", "ACTIVE_LINK_ATTEMPT_EXISTS", "WORKER_ALREADY_RUNNING"].includes(error?.message);
      return res.status(bad ? 409 : 500).json({ error: bad ? error.message : "Server error" });
    }
  });

  router.get("/link-attempt/:attemptId", async (req, res) => {
    if (!workerManager) return res.status(503).json({ error: "Connection manager unavailable" });
    const attempt = await workerManager.getLinkStatus(req.connectionBusinessId, req.params.attemptId);
    return attempt ? res.json({ attempt }) : res.status(404).json({ error: "Not found" });
  });

  router.post("/link-attempt/:attemptId/cancel", async (req, res) => {
    const cancelled = await cancelOwnedLinkAttempt(db, req.connectionBusinessId, req.params.attemptId);
    if (!cancelled) return res.status(404).json({ error: "Not found" });
    await workerManager?.stopBusiness(req.connectionBusinessId);
    return res.json({ ok: true });
  });

  router.post("/reconnect", async (req, res) => {
    if (!workerManager) return res.status(503).json({ error: "Connection manager unavailable" });
    try {
      const attempt = await workerManager.reconnectBusiness(req.connectionBusinessId, req.body?.phone);
      return res.status(201).json({ attempt });
    } catch (error) {
      return res.status(409).json({ error: ["INVALID_PHONE", "ACTIVE_LINK_ATTEMPT_EXISTS"].includes(error?.message) ? error.message : "Reconnect unavailable" });
    }
  });

  router.post("/disconnect", async (req, res) => {
    try {
      const connection = await getWhatsAppConnection(db, req.connectionBusinessId) || await initializeWhatsAppConnection(db, req.connectionBusinessId);
      const attemptId = connection?.group?.activeLinkAttemptId;
      if (attemptId) await cancelOwnedLinkAttempt(db, req.connectionBusinessId, attemptId);
      await workerManager?.stopBusiness(req.connectionBusinessId);
      await disableCloudBusinessRoute(db, req.connectionBusinessId);
      await updateGroupConnection(db, req.connectionBusinessId, { status: "disconnected", activeLinkAttemptId: null, reconnectRequired: false, lastHealthyAt: null, lastErrorCode: null });
      return res.json({ ok: true });
    } catch (error) { return res.status(500).json({ error: "Server error" }); }
  });
  return router;
}
