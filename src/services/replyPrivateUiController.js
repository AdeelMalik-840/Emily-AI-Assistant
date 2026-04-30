globalThis.__replyPrivateLock = globalThis.__replyPrivateLock === true;

export function isReplyPrivateLockActive() {
  return globalThis.__replyPrivateLock === true;
}

export function tryAcquireReplyPrivateLock(meta = {}) {
  const bookingId = meta?.bookingId != null ? String(meta.bookingId).trim() : "";
  console.log("[reply_private_lock_acquire_requested]", {
    bookingId: bookingId || null,
  });
	  if (globalThis.__replyPrivateLock === true) {
	    console.log("[reply_private_lock_busy]", {
	      bookingId: bookingId || null,
	    });
	    console.warn("[reply_private_lock_timeout]", {
	      bookingId: bookingId || null,
	      reason: "LOCK_BUSY",
	    });
	    return false;
	  }
  globalThis.__replyPrivateLock = true;
  console.log("[reply_private_lock_acquired]", {
    bookingId: bookingId || null,
  });
  return true;
}

export function releaseReplyPrivateLock(meta = {}) {
  const bookingId = meta?.bookingId != null ? String(meta.bookingId).trim() : "";
  if (globalThis.__replyPrivateLock === true) {
    globalThis.__replyPrivateLock = false;
  }
  console.log("[reply_private_lock_released]", {
    bookingId: bookingId || null,
  });
}
