# Brain semantic authority refactor — safety contract

Baseline: `255ba40cc2be532003a1abd630690ad52b847bec`

This refactor changes semantic decision ownership only. Existing executors, booking/availability lifecycle, owner approval, delivery, dedupe, ledger, and recovery remain unchanged until a later slice explicitly proves a change is required.

## Durable boundary

1. Brain decides customer meaning once.
2. Deterministic code extracts/verifies facts and trusted context.
3. Workflow routing may enforce lifecycle/state ownership but must not reinterpret customer wording.
4. Executors validate exact IDs, permissions, lifecycle and mutation safety.
5. Customer wording is generated only from trusted facts/results.

## Rollback discipline

- `main` baseline above remains untouched.
- Each semantic-authority slice is committed independently.
- A checkpoint branch is created before the first behavior-changing slice.
- No merge or deploy until targeted + regression tests are reviewed.
- If a slice regresses behavior, revert that slice or reset the feature branch to the checkpoint; never rewrite `main`.

## Explicit non-goals

- No new semantic service or mini-Brain.
- No phrase-specific regex fixes.
- No executor rewrite.
- No booking/AVR lifecycle redesign.
- No Group/DM canned reply engine.
