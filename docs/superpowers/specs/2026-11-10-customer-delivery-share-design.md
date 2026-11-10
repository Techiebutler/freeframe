# Kunden-Delivery + Media-Buyer-Link auf Share-Links — Spec · Größe: M

Quelle: Handout „Aditor Delivery und Share Links" (aditor-ops `docs/handouts/`, 2026-11-10). Entscheidungen Alan 2026-11-10: Delivery lebt auf der FreeFrame-Share-Seite · Editor-Selfie + Satz optional in v1 · öffentliche Vorschau NICHT in v1 · Check-in während Produktion = Phase 2 (eigener Spec).

## Warum
Kunden bekommen heute einen Share-Link, der wie ein Datei-Viewer aussieht. Alan will einen Unboxing-Moment auf dem Handy, den man screenshotten will, plus einen Link für den Media Buyer, der nur freigegebene Versionen mit Download enthält. Alles dafür Nötige (Share-Links mit approve, versionsgebundene Approvals, Multi-Asset-Links, Token-Stream) existiert schon; es fehlt die Kunden-Haut und ein Filter „nur Freigegebenes".

## Was
1. **Batch-Ansicht** (`/share/<token>` bei `permission=approve`, mobile-first, dark): Kopf „Dein Batch ist da." + Projektname · großer Player · Varianten als Chips (eine pro Asset) · Editor-Credit (Avatar + Name; optional Selfie + ein Satz aus der Delivery-Note) · zwei Aktionen: **Feedback** (bestehende Talk+Draw/Kommentare, zeitgestempelt) und **Freigeben** (bestehender Approval auf die gezeigte Version).
2. **Media-Buyer-Link**: Share-Link mit `approved_only=true`, `permission=view`, `allow_download=true`. Server liefert ausschließlich Versionen mit mindestens einer Approval (`approvals.status=approved`); Dateiname = `<projekt>-<asset>-v<n>.mp4`. Wird in der Batch-Ansicht erzeugt, sobald ≥1 Version freigegeben ist: Button „An Media Buyer senden" → Link kopieren / `navigator.share`.
3. **Link-Vorschau (OG-Tags)**: Buyer-Link ⇒ „<Marke> · Editor Delivery", Projektname, Cover = Thumbnail der ersten freigegebenen Version. Kunden-Prüflink (approve) ⇒ „<Marke> · Editor Delivery", Projektname, neutrales Aditor-Cover (keine unfreigegebenen Creatives in Chat-Caches). Alan 2026-11-11: Marke + Projekt + Cover gewollt, damit der Media Buyer sieht, dass Editoren im Spiel sind.

## Grenzen
- **Muss:** Freigabe bleibt an der Version (`uq_approvals_version_user`); neue Version ⇒ keine Freigabe, Buyer-Link zeigt sie nicht · jede Stream-/Thumbnail-/Download-Anfrage im Buyer-Link prüft `approved_only` serverseitig · widerrufener/abgelaufener Link ⇒ bestehende Fehlerseite · iPhone-Viewport 393 px ohne horizontales Scrollen.
- **Darf nicht:** Original-/S3-URLs im HTML oder in Metadaten · Asset-Baum, Upload, New Folder in der Kunden-Ansicht (Memory 04.11.) · Prozentbalken oder erfundener Status · bestehende Share-Seite für Editoren/Teams umbauen (nur Branch `permission=approve` bekommt die Haut) · neue Dependencies.
- **Out of Scope (YAGNI):** öffentliche Vorschau · Check-in-Thumbnails aus Gen · Social-Share-Bild · Wallet/Live Activities · Benachrichtigungen · Reel-Referenz-Karte.

## Ausgangslage (verifiziert 2026-11-10, `main` f6488a9)
| Fakt | Beleg |
|---|---|
| Share-Link: `permission` view/comment/approve, `expires_at`, `password_hash`, `allow_download`, `show_versions`, `appearance.theme` | `apps/api/models/share.py` |
| Multi-Asset-Link über `share_link_items` | `POST /projects/{id}/share/multi`, `share.py:1067` |
| Stream + Versionen über Token, `download` respektiert `allow_download` | `share.py:1346-1457` |
| Approval ist versionsgebunden | `apps/api/models/approval.py:20` |
| Share-Approve + Talk/Draw auf Share-Links live | PRs #118/#119 (04.11.) |
| Delivery-Note vom Editor an den Kunden | PR #114 (offen) — wiederverwenden, nicht duplizieren |
| Share-Web-Seite | `apps/web/app/share/[token]/page.tsx`, `components/share/folder-share-viewer.tsx` |

## Tasks
- **T1 — `approved_only` im Share-Link.** Alembic-Migration (Boolean, default false) · Schema + `POST /projects/{id}/share/multi` nimmt es an · pure Funktion `visible_versions(link, asset, approvals)` in `apps/api/services/share_scope.py`; `/share/{token}/assets`, `/stream`, `/thumbnail`, `/versions` nutzen sie · Download-Dateiname aus Projekt/Asset/Versionsnummer. **Verifiziert:** neues `apps/api/tests/test_share_approved_only.py`: nicht freigegebene Version ⇒ 404 im Buyer-Link; neue Version nach Freigabe ⇒ nicht sichtbar; Link ohne Flag unverändert.
- **T2 — Batch-Ansicht (Web).** Neue Komponente `components/share/batch-view.tsx`, gerendert wenn `permission === "approve"`. Dark, Aditor-Tokens, 44-px-Targets, Varianten-Chips, Player oben, Credit (Avatar/Name; Selfie + Satz nur, wenn Delivery-Note vorhanden), Feedback + Freigeben. Alle anderen Permissions rendern wie heute. **Verifiziert:** `npm run build` in `apps/web` exit 0 · vitest für `batch-view` (rendert ≥2 Varianten, Freigeben ruft bestehenden Approve-Handler) · Screenshots 393×852 (vor Freigabe, nach Freigabe) nach `reviews/assets/`.
- **T3 — „An Media Buyer senden".** In `batch-view`: nach ≥1 Approval Button sichtbar; erzeugt per bestehendem `POST /projects/{id}/share/multi` einen Link mit `approved_only=true, permission=view, allow_download=true, show_versions=false`; Share-Sheet oder Zwischenablage. Idempotent: zweiter Klick liefert denselben Link (Lookup über `project_id + approved_only + created_by`). **Verifiziert:** vitest: zweiter Klick macht keinen zweiten POST · Screenshot des Sheets.
- **T4 — OG-Tags.** `generateMetadata` in `app/share/[token]/page.tsx`: Titel „<Marke> · Editor Delivery", Beschreibung = Projektname; Bild = Thumbnail der ersten freigegebenen Version über den Token-Thumbnail-Endpoint bei `approved_only`, sonst festes Aditor-Cover aus `public/`. **Verifiziert:** vitest: approve-Link liefert nie eine Asset-Thumbnail-URL in `og:image`; Buyer-Link liefert sie.

## Done (maschinell prüfbar)
`cd apps/api && pytest tests/test_share_*.py tests/test_share_approved_only.py` grün · `cd apps/web && npm run build && npx vitest run components/share` grün · 3 Screenshots in `reviews/assets/2026-11-*-batch-*.png` · im Report der 404-Curl auf eine nicht freigegebene Version im Buyer-Link wörtlich zitiert.

## Stop & Eskalation
- PR #114 (Delivery-Note) ist noch nicht gemergt ⇒ Credit ohne Selfie/Satz bauen, im Report vermerken; #114 nicht im Branch nachbauen.
- `share_link_items` zeigt auf Asset, nicht Version, und die Approve-Permission lässt sich nicht pro Version prüfen ⇒ stoppen, Modellfrage in den PR-Body.
- Gleicher Test 2× rot trotz Fix ⇒ stoppen.
- Kein Deploy, keine Prod-Migration: Preview nur lokal/Branch (CI im Repo läuft seit 22.10. nicht ⇒ `next build` selbst ausführen).

## Fehlerklassen
| Fehler | Verhalten |
|---|---|
| Link widerrufen/abgelaufen/falsches Passwort | bestehende Fehlerseite, kein Asset-Metadatum vorab |
| Version ohne Approval im Buyer-Link angefragt | 404, keine Datei, geloggt |
| Stream/Thumbnail temporär nicht erreichbar | Player-Retry (bestehend), Chip bleibt klickbar, kein „fertig"-Badge |
| Approve schlägt fehl (Netz) | Button zurück in Ausgangszustand, Toast, kein lokaler „freigegeben"-State |
| Buyer-Link-Erzeugung schlägt fehl | Toast, kein halber Link in der Zwischenablage |

## Doctrine-Gate
- [x] **M1** Purpose + Non-Goals oben; Entscheidungen Alans eingetragen.
- [x] **M2** Keine neue App, ein Boolean + eine Komponente auf vorhandenen Share-Links.
- [x] **M3** Done = pytest/vitest/build/Screenshots/Curl; Stop-Regeln explizit.
- [x] **1 State:** Approval-Tabelle ist Wahrheit; Sichtbarkeit wird daraus abgeleitet, nie kopiert.
- [x] **2 SoC:** `share_scope.visible_versions` pure, Router nutzt sie.
- [x] **3 Idempotenz:** Buyer-Link-Erzeugung per Lookup, Approvals per Unique-Constraint.
- [x] **4 Coupling:** Vertrag = `approved_only` + Approval-Status, keine Namen als Schlüssel.
- [x] **5 Context:** 4 Tasks, je ein Commit.
- [x] **6 Error-Taxonomie:** Tabelle oben.
- [x] **7 Defensive:** 404 statt Fallback-Datei, Fehler sichtbar statt verschluckt.
- [x] **F1:** Bestand zuerst geprüft; nichts Vorhandenes neu erfunden.
- [x] **Tests:** pure `visible_versions` + Komponententest, kein voller Stack.
