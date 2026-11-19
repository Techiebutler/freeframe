# AutoReview takes over an approval Alan gave in Gen (ADI "Approve anyway")

Status: spec only. Build starts once Alan says yes (via 5d). Owner: 01 (FreeFrame + Worker), e9 (Gen call).

## Purpose

Alan decided on 20.11.: if an agent disagrees with a must-fix from the auto check, Gen asks him through an ADI. If he picks "Approve anyway", Gen counts the part as approved (e9 #902). Today AutoReview never hears about it. The version stays unapproved there, and the customer link has no approval badge. Delivery runs in Gen but not in AutoReview.

Goal: one approval and the same state in both systems. Approving there must have exactly the effect it has when Alan presses Approve in AutoReview himself.

## Non-goals (YAGNI)

- Agents still cannot approve on their own. `agents_may_approve` and `POST /agent/assets/{id}/approve` stay as they are.
- Rejects and un-approves do not go through this route. Taking an approval back stays a human action in AutoReview: a new comment round or the Unapprove button.
- Changing the must-fix gate is out of scope. "Approve anyway" is Alan's decision, and AutoReview does not check it again.
- No new table and no migration.

## Path

Same pattern as Gen's existing `GET /api/v1/internal/paired` (feedback-agent `src/index.ts`, around line 6563):

```
Gen backend --X-Suite-Secret--> review.aditor.ai  POST /api/v1/internal/approve
            --Bearer FREEFRAME_BRIDGE_SECRET--> feedback.aditor.ai/api  POST /internal/assets/{asset_id}/approve
```

Deviation from the brief: the brief named a change to `POST /agent/assets/{id}/approve`. That route takes an agent key, and every agent holds one. Adding a flag to it would let any agent set `decided_via: "adi"`. A separate internal route that accepts only the bridge secret keeps the rule "no agent approves" hard in the code.

### Worker: `POST /api/v1/internal/approve`

- Auth: `X-Suite-Secret` == `SUITE_INGEST_SECRET` (timing-safe), otherwise 401.
- Body is passed through unchanged. FreeFrame answers, and the Worker hands that status and body back 1:1.
- FreeFrame unreachable: 502 `freeframe_unavailable`. Timeout 8 s.

### FreeFrame: `POST /internal/assets/{asset_id}/approve`

- Auth: `Authorization: Bearer <review_bridge_secret>`, the same check as `_require_review_bridge` (`routers/comments.py:998`). Missing or wrong: 403. Secret not configured: 503.
- Body:
  ```json
  { "version_id": "uuid", "decided_by": "alan@aditor.ai", "decided_via": "adi", "decision_id": "string, max 120" }
  ```
- Rules, in this order:
  1. The asset exists and is not deleted, otherwise 404 `not_found`.
  2. `decided_by` is the owner of the asset's project (`Project.created_by`, compared by email, case-insensitive). Otherwise 403 `not_owner`. The approver is the person who decided in the ADI, never the agent.
  3. `version_id` is the newest non-deleted version of the asset. Otherwise 409 `version_moved`, with `current_version_id` in the body.
  4. `decided_via` is `"adi"`, otherwise 422.
  5. Idempotent: if the same version is already approved by that person, return 200 with the same answer and add no second activity row.
- Effect: the same steps as `routers/approvals.py approve_asset`, except role check and email:
  - `_upsert_approval(db, asset, version_id, owner, approved, note="adi:<decision_id>")`
  - `ActivityLog(action=approved, user_id=owner)`
  - `deliveries.on_approved(db, asset, version_id, owner)`. The existing agent route does NOT have this step, which is another reason for a separate route.
- Answer 200: `{ asset_id, version_id, status: "approved", delivery, parts }`, the same shape as `share_approve`.

## What the customer link shows

The approval belongs to the owner, exactly as if Alan had pressed Approve in AutoReview:

- The part gets the approval badge on the review link and in the embed.
- Once all parts of the request are approved, the delivery comes into being through the normal `deliveries.on_approved` path. The rule "a delivery exists only when ALL parts are approved" still holds.
- `approval: "approved"` in `list_queue`. Gen's review-ready sees the part as approved.
- Later rules stay in force:
  - A new human comment round on that version voids the approval (`void_approvals_commented_after`).
  - An upload onto the approved version needs `reopen`.

## Gen (e9)

- Exactly once after an ADI answer "Approve anyway": call the Worker route with `version_id` = the version the ADI showed, `decided_by` = the email of the person who answered, `decision_id` = the ADI id.
- 200: done, and the Gen approval matches.
- 409 `version_moved`: the Gen approval stays local. Do not retry. The next version goes through the normal ADI again.
- 401, 403 or 5xx: the Gen approval stays local, log one line, no automatic retry. Delivery in Gen does not depend on this call.

## Error classes

| Code | Meaning | Caller does |
|---|---|---|
| 401 (Worker) | Wrong suite secret | Fix config. Never retry. |
| 403 `not_owner` | The decider is not the project owner | Stays a Gen approval |
| 403 / 503 (FreeFrame) | Bridge secret wrong or missing | Fix config |
| 404 `not_found` | Asset gone | Stays a Gen approval |
| 409 `version_moved` | A newer version exists | Ask again on the next version |
| 422 | Body invalid | Bug at the caller |
| 502 `freeframe_unavailable` | FreeFrame down (deploy: about 1 min of 503) | Stays a Gen approval |

## Tests

FreeFrame (pytest):
- Wrong or missing secret gives 403. An empty secret config gives 503.
- `decided_by` is not the owner: 403, no approval row.
- `version_id` is not the newest: 409 with `current_version_id`, no approval row.
- Happy path:
  - an approval row with note `adi:<id>` and the owner as user_id
  - an activity row `approved`
  - `list_queue` shows `approval: "approved"`
- Last part approved: the delivery exists (`deliveries.on_approved`), and `parts` shows n/n.
- Second call with the same body: 200, still exactly one approval row and one activity row.
- A human round on that version closes afterwards: the approval is voided, like a person's.

Worker (vitest): 401 without the secret. Status and body pass through. FreeFrame timeout gives 502.

## Stop & escalate

Stop and ask through 5d (no workaround) if:
- the project owner is not unique, for example several workspaces per brand with different owners;
- `deliveries.on_approved` needs a role the owner does not have in the project;
- Gen cannot reliably supply the version the ADI showed, only "the newest";
- AutoReview's must-fix gate prevents the delivery even though the approval is set.

## Doctrine gate

- [x] Purpose and non-goals written down (M1).
- [x] Data contract fixed: route, body, answers, error classes.
- [x] Smallest working path: one internal route plus one Worker pass-through, no table, no migration. It reuses the existing secrets and `_upsert_approval` / `deliveries.on_approved`.
- [x] Safety: no agent can approve. Only the bridge secret plus the owner email gets through. Version-exact (409).
- [x] Errors are idempotent, and no automatic retry follows a mutation.
- [x] Proof before done: the tests above are green. After the deploy, one real ADI "Approve anyway" on a test request shows the badge on the review link and `approval: "approved"` in `list_queue`.
- [ ] Alan's yes (via 5d).

Effort: FreeFrame route plus tests about 3 h, Worker pass-through about 30 min, Gen call (e9) about 30 min. Each side needs one deploy, FreeFrame with about 1 min of 503.
