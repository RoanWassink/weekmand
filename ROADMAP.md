# Roadmap Weekmand

Stand 14 november 2026 (versie 2.1.0; wat er per versie veranderde staat in `CHANGELOG.md`). "Gebouwd" betekent: werkt met de demowinkel en synthetische Picnic-antwoorden in de tests. "Live test open" betekent: nog niet met het echte Picnic-account of de echte router geprobeerd.

| Fase | Onderdeel | Stand | Klaar wanneer |
| --- | --- | --- | --- |
| 1 | Kern: recepten, verpakkingen, idempotente mandberekening, SQLite | Gebouwd en getest | — |
| 1 | Voorraad met schatting, vragen, barcode, minimum | Gebouwd | Een week echt gebruikt; schattingen kloppen ongeveer |
| 2 | MCP-server en OpenAPI | Gebouwd, lokaal getest | Gekoppeld aan Claude Code/Desktop en weekmenu + mand via Claude aangepast |
| 2 | Chat (webapp, Telegram) met AI of commando's | Gebouwd, AI-lus getest met nagebootste antwoorden | Eén gesprek met een echte AI-sleutel |
| 3 | Picnic: mand, producten koppelen, bezorgmoment, sessie onthouden | In gebruik; geplaatste bestelling telt mee, mand per gerecht of afdeling | — |
| 3 | Deadline-melding met ja/nee en mand goedkeuren | In gebruik; na afrekenen alleen wat nog ontbreekt | — |
| 3 | Menu met AI: eigen recepten en nieuwe van Lekker en Simpel | Gebouwd, getest op een kopie van de echte gegevens | Een week gekookt van een AI-menu |
| 3 | Vaste producten uit geschiedenis | Gebouwd, live test open | Voorstellen kloppen met wat het huishouden echt elke week koopt |
| 3 | Leren van afwijzingen | Gebouwd | Eerste echte voorstel na twee weken |
| 4 | NanoPi R4S: Node-dienst, uitrol, LAN-toegang | Draait op de router; updates via de knop in de webapp (root-updater met back-up en terugval) | Eerste update via de knop geïnstalleerd |
| 4 | Home Assistant via MQTT | Gebouwd, getest met nep-broker | Sensoren en knoppen zichtbaar in Home Assistant |
| 4 | Docker (Alpine, < 150 MB) | Dockerfile klaar, build niet getest | Image gebouwd voor linux/arm64 |

## Eerstvolgende verificatie

1. Versie 2.1.0 installeren met de updateknop rechtsboven in de webapp.
2. **Stel menu voor** met de AI voor de week van 21 november en de nieuwe recepten nalopen.
3. Na het afrekenen in Picnic: de deadline-melding meldt alleen wat nog ontbreekt.
4. Na de deadline: Weekmand plant vanzelf voor zaterdag 28 november.

## Open keuzes

- Live camerascannen vraagt HTTPS (de browser staat de camera anders alleen via een foto toe). Een zelfondertekend certificaat op de router of een tunnel zou dat oplossen.
- Productvarianten en vervangingen van Picnic (tijdelijk niet leverbaar) worden nu alleen gemeld, niet automatisch vervangen.
