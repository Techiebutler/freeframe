# ROADMAP — freeframe (AutoReview)

## Ready
- **Kunden-Delivery + Media-Buyer-Link** — Batch-Ansicht auf `/share/<token>` bei `permission=approve`, `approved_only`-Share-Links mit Download für Media Buyer, OG-Tags mit Marke + Projekt. Spec: `docs/superpowers/specs/2026-11-10-customer-delivery-share-design.md`. Fertig: pytest `test_share_*` grün, `apps/web` build + vitest grün, 3 Screenshots 393 px in `reviews/assets/`, 404-Curl auf nicht freigegebene Version im Report.

## Später
- Check-in während Produktion (2–3 passive Asset-Einblicke aus Gen-Cards) — eigener Spec nach dem Delivery-Piloten.
- Öffentliche Vorschau als dritter Link-Typ.
