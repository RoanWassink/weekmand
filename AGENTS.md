# Werken aan Weekmand

- Houd `ROADMAP.md` bij wanneer een onderdeel of open keuze verandert.
- Alle bedieningsroutes (webapp, chat, Telegram, MCP, OpenAPI, Home Assistant) gaan via de servicelaag `src/app.ts`; nieuwe functies voor AI-clients komen als tool in `src/tools.ts`, niet als losse route.
- Houd Picnic-authenticatie en responsnormalisatie in `src/shop.ts`. Gebruik tests met synthetische fixtures zonder accountgegevens.
- Sla nooit een Picnic-wachtwoord of sms-code op. Sessiesleutels, AI-sleutels en tokens staan alleen in `data/secrets.json` (rechten 600) en alleen als de gebruiker "onthouden" aanvinkt; nooit in SQLite, logs, broncode of fixtures.
- Een wijziging aan de echte mand vereist expliciete goedkeuring: een knop of `confirm_cart_update` na het tonen van de wijzigingen. Taalmodellen in de chat krijgen geen tool om zelf toe te passen. Weekmand start geen checkout en plaatst geen bestelling.
- De mandberekening is idempotent: wat de gebruiker zelf toevoegt blijft staan; Weekmand beheert alleen haar eigen toevoegingen (het grootboek). Houd die eigenschap vast in `test/planner.test.ts`.
- Alleen "erasable" TypeScript (geen enums, namespaces of parameter properties): Node draait de bestanden zonder build.
- Behoud de demowinkel als lokale testomgeving. Voer `npm test` uit bij elke wijziging.
- UI- en ontwerpwerk (webapp in `public/`) gaat via de skill **Impeccable** (`.claude/skills/impeccable`, voor Codex `.agents/skills/impeccable`, versie 4.7.0). De webapp is een Operate-oppervlak: bekende patronen, op de telefoon hooguit vijf tabs. De launcher `scripts/impeccable` downloadt een programma; draai die alleen met akkoord van de gebruiker.
- **Versies en changenotes.** Het versienummer staat alleen in `package.json`. Elke wijziging die naar `main` gaat, verhoogt het (x.y.Z voor een reparatie, x.Y.0 voor iets nieuws) en krijgt in `CHANGELOG.md` een kopje `## x.y.z — datum` met korte, functionele punten in gewone taal (wat merkt het huishouden), niet technisch. Het updatevenster in de webapp laat die punten zien.
- **Uitrollen gaat via GitHub.** De gebruiker installeert updates zelf met de updateknop in de webapp (de root-updater haalt de top van `main`). Rol niet zelf uit naar de NanoPi, tenzij de gebruiker daar om vraagt.
