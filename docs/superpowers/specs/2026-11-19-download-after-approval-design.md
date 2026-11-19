# S2 · Download erst nach Freigabe

Stand 2026-11-19 · Quelle: Handoff `admixer-autoreview-handoff-2026-11-19.md` (L1, L11), Entscheidungen E1/E5 (Alan).

## Purpose

Vor einer menschlichen Freigabe gibt es keinen Download des Originals, über keinen Weg: Reviewer-Ansicht, Bulk,
Share, Embed, `stream?download=true`, Iterations-Outputs. Das schließt das Leck auch für normale Requests.

## Regel

`may_download(project, version, user)` (`apps/api/services/download_gate.py`) ist wahr, wenn
1. eine `Delivery` für die Version existiert. Nur der menschliche Approve-Pfad (`deliveries.on_approved`) legt sie an,
   ein Multi-Part-Request erst, wenn alle Teile frei sind. Agent-Approve (`agent.py`) legt keine an → kein Download (L6).
2. oder der Aufrufer Projekt-Owner ist (E1: Entwurf in der Reviewer-Ansicht; Superadmins sind implizit Owner),
3. oder der Aufrufer der Service-Key der Review-Engine ist (`SERVICE_API_KEY_EMAIL`). Sonst bricht die Auto-Prüfung,
   die das Original über `/share/{token}/stream/{id}?download=1` liest (feedback-agent `index.ts` `resolve`).

Nie `AssetStatus.approved`: das setzt der Iteration-Runner automatisch (L11).

Iterations-Outputs (`/r/{token}/…/download`, `/requests/{id}/…/download`): zusätzlich zu `delivered` müssen alle
Teile des Requests menschlich freigegeben sein (`deliveries.progress().complete` und mindestens ein Teil).

## Stellen

| Weg | Datei | Verhalten vor Freigabe |
|---|---|---|
| Reviewer-Ansicht, Bulk (Dashboard) | `routers/assets.py` `get_stream_url` | 403 `not_released` (außer Owner) |
| Share, Embed (Einzel), Ordner-Share | `routers/share.py` `get_share_stream_url` | 403 `not_released` |
| Iterations-Output Gast/Owner | `routers/iterations.py` `download` | 403 `not_released` |
| Abgabe-Seite `/d/<token>` | `routers/deliveries.py` | existiert nur nach Freigabe, unverändert |

Web: Share-Topbar zeigt bei 403 „Available after approval“ statt still zu scheitern.

## Non-Goals / YAGNI

- `allow_download` der Request-Links bleibt `true`. Das Gate entscheidet jetzt, und die Engine prüft das Flag (`share-downloads-disabled`).
- Kein Gate auf HLS/`review_540`/`ai-proxy`. Das sind Abspiel-Proxies in Review-Qualität, kein Original.
- Der alte Share-Import des Reviewers (`feedback-agent` `/api/freeframe`, ohne Service-Key) bekommt nur noch freigegebene Versionen. Gewollt: Mit Key würde er anonymen Aufrufern Original-URLs liefern.
- Keine neue UI für das „Download erscheint bei Freigabe“. Das gehört zur Abgabe in S1.

## Fehlerklassen

- Nicht freigegeben → 403 `not_released`, kein Retry, die UI sagt „nach Freigabe“.
- Version/Datei fehlt → 404 wie bisher (vor dem Gate).
- Freigabe zurückgenommen, solange der Link nicht weitergegeben ist → die Delivery wird gelöscht (`on_unapproved`), der Download ist wieder zu.

## Done (maschinell)

CI `pytest apps/api/tests` grün, dabei:
- `test_download_gate.py`: Matrix aus Owner, Editor, Reviewer, Gast, Engine × mit/ohne Delivery.
- `test_assets_stream_url.py::test_video_download_before_approval_is_refused`.
- `test_iterations.py::test_rendered_output_stays_locked_until_a_human_approved_every_part`.
- `test_request_visibility_postgres.py`: Download mit Delivery weiterhin 200.

Live (Probelauf §7.2): vor der Freigabe liefern Share, Embed, `stream?download=true` und `outputs/{key}/download` 403.

## Stop & Eskalation

Bricht nach dem Deploy die Auto-Prüfung (Engine-Download 403), heißt das: `SERVICE_API_KEY_EMAIL`/`FREEFRAME_SERVICE_API_KEY`
fehlen in prod. Dann sofort revert und Alan fragen, nicht den Owner-Bypass aufweichen.

## Doctrine-Gate

- [x] M1 Purpose + Non-Goals oben.
- [x] M2 Eine Funktion, drei Aufrufe. Kein Flag, keine Migration.
- [x] M3 Done = CI-Tests + Live-Check §7.2. Stop-Regel oben.
- [x] 1 State: `Delivery` ist die einzige Quelle für „freigegeben“.
- [x] 2 SoC: Gate in `download_gate.py`, die Router rufen es nur auf.
- [x] 3 Idempotenz: reiner Read.
- [x] 4 Coupling: 403-Detail `not_released` ist der Vertrag zur Web-UI.
- [x] 5 Context: N/A, kleiner Diff.
- [x] 6 Fehlerklassen oben.
- [x] 7 Defensive: 403 statt Catch. Die Engine-Ausnahme ist explizit benannt.
- [x] F1 N/A, kein Modell im Spiel.
- [x] Tests: reine Gate-Matrix mit Mocks, kein Stack.
