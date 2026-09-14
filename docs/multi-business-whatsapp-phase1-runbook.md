# Multi-business WhatsApp Phase 1 runbook

This implementation is disabled by default. Do not enable it in production until the host and external-service gates below are proven.

## Required runtime gates

- Exactly one connection-manager instance, or add a distributed Firestore worker lease first.
- A persistent filesystem mounted at `PLAYWRIGHT_DATA_ROOT`.
- Child-process and Chromium support, including the display/headless configuration used by the live environment.
- Capacity and restart testing for the intended 10–20 browser workers.
- A production secret provider wired through `setWhatsAppSecretProvider`; new tenants fail closed without it.
- Meta POST webhook signatures configured with `META_APP_SECRET` and enforcement enabled.

Set `WHATSAPP_SINGLE_MANAGER=true` only when the deployment actually guarantees one manager. Enabling multi-business mode in production without that guarantee causes startup to fail.

## Cloud provisioning per business

An operator must provision and verify the WABA, phone number ID, credential secret/reference, approved notification templates, webhook subscription, and required permissions. Assign the route only after the credential bundle and destination phone number ID have been verified together.

The legacy bootstrap is explicit and non-automatic:

```text
node scripts/bootstrap-legacy-whatsapp-connection.mjs --apply
```

It requires the configured legacy Firebase UID and complete matching environment credential pair. It does not recreate the business or trust legacy connected flags.

Import an existing browser session with:

```text
node scripts/import-legacy-playwright-session.mjs <firebase-uid> <session-json-path>
```

The importer refuses to overwrite an existing tenant session. Do not place session files in Firestore, logs, API responses, or source control.

## Live WhatsApp Web compatibility checklist

Use a nonproduction WhatsApp account only with explicit authorization. Confirm:

1. The phone-number login action is found through its accessible role/name.
2. Country and phone input work for supported regions.
3. The eight-character linking code is read from scoped DOM/accessibility content.
4. The code is never printed to ordinary logs.
5. Expired and cancelled attempts close the temporary browser.
6. Linked-device approval produces the authenticated `#pane-side` state.
7. Storage state is written only to the assigned business directory with restrictive permissions.
8. The saved session restores after a worker and host restart.
9. A linker and long-running listener never own the same session concurrently.
10. Failure for one business leaves another business worker healthy.

## Cutover flags

`MULTI_BUSINESS_WHATSAPP_ENABLED=true` implies strict Cloud routing and strict complete credentials in code. Also configure:

```text
WHATSAPP_SINGLE_MANAGER=true
META_WEBHOOK_SIGNATURE_ENFORCED=true
PLAYWRIGHT_DATA_ROOT=<persistent mounted path>
```

Do not enable the cutover until the mobile repository provenance, production secret provider, Cloud provisioning, live WhatsApp compatibility, Firestore rules deployment, and full regression suite are complete.
