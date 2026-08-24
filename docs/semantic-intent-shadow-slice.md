# Semantic intent shadow slice

This slice exposes a shared `semanticIntent` only from meaning already present in the existing Brain decision.

Safety constraints:
- no customer-text parsing in the semantic-intent projector
- no regex/keyword semantic routing
- no WorkflowEngine consumption of `semanticIntent` yet
- no executor, availability lifecycle, booking lifecycle, ledger, or delivery changes
- ambiguous `booking_fact` stays `null` rather than being guessed as pricing/availability/booking

This is deliberately shadow-only. A later slice may make the existing Brain emit explicit normal-turn `semanticIntent`; routing authority must not switch before that output is characterized and tested.
