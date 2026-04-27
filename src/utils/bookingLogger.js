import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BOOKING_FLOW_LOG = fileURLToPath(
  new URL("../../.cursor/booking-flow.log", import.meta.url)
);

/**
 * Production booking-flow trace: one JSON object per line (console + NDJSON file).
 * @param {{
 *   traceId: string,
 *   step: string,
 *   status: "start" | "success" | "fail",
 *   data?: Record<string, unknown>,
 * }} p
 */
export function logBookingEvent({ traceId, step, status, data = {} }) {
  const lineObj = {
    traceId,
    step,
    status,
    data,
    timestamp: Date.now(),
  };
  const line = JSON.stringify(lineObj);
  console.log(line);
  try {
    appendFileSync(BOOKING_FLOW_LOG, `${line}\n`);
  } catch (err) {
    console.warn(
      `[bookingLogger] file append failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
