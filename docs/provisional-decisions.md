# Provisional decisions

**Recorded:** 2026-10-09. The owner deferred these to a later review and asked the implementer to
decide for now. Each one is a default that development continues on. It is **not** an accepted
design. Revisit every entry before inviting players. Gate ids refer to
[the milestone B results](../artifacts/milestone-b-results.md) §8.

| Id | Question | Provisional call | Revisit when |
|---|---|---|---|
| D-01 | Catch-up cost (R202): catch-up runs inline on the API event loop, about 0.6 s per 12 h reconnect and about 9.5 s for sixteen at once | **Accept inline for now.** No players yet, so nothing contends. The worker-thread executor and a bounded queue are not built. | Before any invite, or once the VPS load run (B-27) measures real reconnect volume |
| D-02 | Login rate limit and `X-Forwarded-For` | **Implemented.** The header is ignored unless `NAROK_TRUST_PROXY=1`. With it set, the limit uses the rightmost entry, the one our proxy appended. The test harnesses set it. | At deploy: confirm Caddy fronts the API and set `NAROK_TRUST_PROXY=1` there. Without it, every player shares the proxy's bucket. |
| D-03 | Potion and equipment prices (B-15) | **No prices invented.** The shop stays behind its feature flag and answers `MAINTENANCE`. | When the owner sets prices. Then build bulk sale and its reconciliation test. |
| D-04 | Onboarding in milestone B (B-24, §4.2) | **Deferred to Phase C.** Presets for new accounts keep coming from the harness provisioning (R197). | When Phase C is scoped |
| D-05 | Content-version change on the client (B-29) | **Accept the reload message** (part 4 §7 option (a): content is bundled, and a mismatch forces a reload). No refetch or invalidation. | If content ever ships separately from the client bundle |
| D-06 | Human checks: B-19 read-through, B-21 keyboard and colour, B-22 screenshots | **Left open, not blocking development.** They need a person. | Before any invite |
| D-07 | Operator work: B-27 VPS load run, B-28 real content migration | **Left open.** They need the VPS. | When the VPS exists |
| D-08 | Pushing `main` and the first CI run | **Not done on my own.** A push is outward-facing, so it waits for an explicit ask. | Whenever the owner says push |
