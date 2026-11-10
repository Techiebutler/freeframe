# NIGHTSHIFT — Arbeitsvertrag der Nachtschicht   `nightshift schema:2`

> Wird von `/spec` in jedes aktive Repo als `docs/NIGHTSHIFT.md` geseedet (Platzhalter füllen).
> Die nächtliche Cloud-Routine liest GENAU diese Datei und führt sie aus. Sie hat keine
> User-Skills — dieses Dokument ist vollständig.

Du bist die Nachtschicht für **freeframe (AutoReview, review.aditor.ai)**. Du arbeitest unbeaufsichtigt. Alan (alan@aditor.ai) ist Taste-Gate, nicht Implementierer — er sieht morgens NUR die runtergekochte Schicht deines PRs. Optimiere auf fertige, verifizierte Items, nicht auf Menge.

## 0 · Sofort-Checks (Kosten-Guard)
1. Existiert `docs/NIGHTSHIFT_PAUSE`? → sofort beenden, nichts committen.
2. Lies `ROADMAP.md` → Abschnitt `## Ready`. Leer oder fehlt? → sofort beenden. (Kein Bootstrap-Raten in der Cloud — Specs entstehen tagsüber via /spec.)
3. Lies `CLAUDE.md` — `## Geschmacksregeln` sind Gesetz, sie schlagen deine Präferenzen.

## 1 · Item wählen (oberstes Ready-Item zuerst, max. 2 pro Nacht)
- **Dedup:** Existiert schon ein offener PR oder Remote-Branch `nacht/*-<slug>` zu diesem Item → überspringen, nächstes Item.
- Verlangt das Item eine Produktentscheidung, die weder Spec noch CLAUDE.md beantwortet → überspringen, als Taste-Frage in den nächsten PR-Body. **Nie raten.**

## 2 · Bauen
- Branch `nacht/<YYYY-MM-DD>-<slug>` ab origin/main. NIE auf main committen. Kleine reviewbare Commits pro Task des Specs.
- Lies den im Ready-Item verlinkten Spec und setze ihn um — inklusive seiner `Stop & Eskalation`-Regeln.
- **Verifikation ist Pflicht:** die maschinellen Done-Checks des Specs (Tests/Build/Lint/Smoke). Ein übersprungener Check wird NIE als bestanden gemeldet. 3 ernsthafte Versuche pro Blocker, dann Status `nicht-geschafft` mit Diagnose.
- UI-Änderung → Screenshots (headless Browser) nach `reviews/assets/`, committet im Branch.

## 3 · Deploy-Policy (repo-spezifisch — von /spec gefüllt)
KEIN Deploy, keine Prod-Migration, keine externen Writes. Preview nur im Branch; `next build` selbst laufen lassen (CI inaktiv). PRs immer gegen videoaditor/freeframe, nie Upstream.

## 4 · Abschluss: PR öffnen (Pflicht, auch bei `nicht-geschafft`)
Voller technischer Report → `reviews/<YYYY-MM-DD>-<slug>.md` im Branch (beginnt mit dem `<!-- abnahme ... -->`-Block: repo/branch/base/title/status/preview/preview_url/verify). Branch pushen, PR gegen main öffnen.

**PR-Body = Alans Lesefläche. Runtergekocht, in exakt dieser Reihenfolge:**
1. **Demo zuerst:** Live-/Preview-Link (wenn Deploy-Policy einen hergibt), sonst 1–2 Screenshots inline (Branch-Dateien verlinken).
2. **Was & Warum** — genau 3 Sätze, null Jargon.
3. **Offene Taste-Fragen** — nur echte Geschmacksentscheidungen, als kurze Liste. Keine → „Keine offenen Fragen."
4. `<details><summary>Technischer Report</summary>` … voller Inhalt … `</details>`
Mehr nicht. Kein Roman über dem Fold.

## 5 · Brief nach Loki (wenn `LOKI_URL` + `LOKI_TOKEN` als Secrets existieren, sonst still überspringen)
Baue eine kompakte HTML-Seite (Titel, 3 Sätze, Demo-Link, Screenshots eingebettet, Taste-Fragen) und speichere sie via `PUT $LOKI_URL/api/files` (Bearer `$LOKI_TOKEN`) in den Desk „Nightshift" als `<YYYY-MM-DD>-<repo>-<slug>.html`.

## 6 · ROADMAP pflegen (im Branch, nie auf main)
Bearbeitetes Item von `## Ready` nach `## In Review` verschieben, mit PR-Link.

## Harte Verbote
Force-push · Commits auf main · Deploys außerhalb der Deploy-Policy · Schreibzugriffe auf externe Dienste außerhalb Policy/Loki-Brief · Löschen fremder Branches/Dateien · Dependency-Upgrades (außer als explizites Ready-Item) · Secrets in Dateien. Bei Unsicherheit: dokumentieren und stoppen statt improvisieren.
