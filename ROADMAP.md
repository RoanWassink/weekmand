# Roadmap Weekmand

Stand 7 november 2026 (versie 2.0.0). "Gebouwd" betekent: werkt met de demowinkel en synthetische Picnic-antwoorden in de tests. "Live test open" betekent: nog niet met het echte Picnic-account of de echte router geprobeerd.

| Fase | Onderdeel | Stand | Klaar wanneer |
| --- | --- | --- | --- |
| 1 | Kern: recepten, verpakkingen, idempotente mandberekening, SQLite | Gebouwd en getest | — |
| 1 | Voorraad met schatting, vragen, barcode, minimum | Gebouwd | Een week echt gebruikt; schattingen kloppen ongeveer |
| 2 | MCP-server en OpenAPI | Gebouwd, lokaal getest | Gekoppeld aan Claude Code/Desktop en weekmenu + mand via Claude aangepast |
| 2 | Chat (webapp, Telegram) met AI of commando's | Gebouwd, AI-lus getest met nagebootste antwoorden | Eén gesprek met een echte AI-sleutel |
| 3 | Picnic: mand, producten koppelen, bezorgmoment, sessie onthouden | Gebouwd, live test open | Echte mand bijgewerkt na goedkeuring; herhalen voegt niets toe |
| 3 | Deadline-melding met ja/nee en mand goedkeuren | Gebouwd | Melding op de telefoon vóór een echte Picnic-deadline |
| 3 | Vaste producten uit geschiedenis | Gebouwd, live test open | Voorstellen kloppen met wat het huishouden echt elke week koopt |
| 3 | Leren van afwijzingen | Gebouwd | Eerste echte voorstel na twee weken |
| 4 | NanoPi R4S: Node-dienst, uitrol, LAN-toegang | Uitrolscript bijgewerkt, nog niet uitgerold | Versie 2 draait op de router, versie 1-gegevens zijn overgezet |
| 4 | Home Assistant via MQTT | Gebouwd, getest met nep-broker | Sensoren en knoppen zichtbaar in Home Assistant |
| 4 | Docker (Alpine, < 150 MB) | Dockerfile klaar, build niet getest | Image gebouwd voor linux/arm64 |

## Eerstvolgende verificatie

1. Versie 2 uitrollen op de router en controleren dat huishouden en historie zijn overgezet.
2. Aanmelden bij Picnic met **Sessie onthouden**; één berekening maken en de automatische productkoppelingen nalopen.
3. Eén keer **Mandje bijwerken** op de echte mand; daarna opnieuw berekenen moet "compleet" geven.
4. Telegram-bot koppelen en **Deadline-melding nu proberen**.

## Open keuzes

- Live camerascannen vraagt HTTPS (de browser staat de camera anders alleen via een foto toe). Een zelfondertekend certificaat op de router of een tunnel zou dat oplossen.
- Productvarianten en vervangingen van Picnic (tijdelijk niet leverbaar) worden nu alleen gemeld, niet automatisch vervangen.
- Of Weekmand Picnic-bezorgmomenten zelf mag kiezen; nu kies je die in de Picnic-app.
