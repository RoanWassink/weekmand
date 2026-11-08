# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Eén huishouden van twee volwassenen. Ze doen hun boodschappen grotendeels via Picnic (bezorging) en vullen aan in de Albert Heijn-winkel. Iedereen in huis gebruikt dezelfde Weekmand: in de webapp op de telefoon, als app op het beginscherm, en via een Telegram-bot. Gebruik is vooral kort en tussendoor: thuis bij het plannen, onderweg, en in de winkel.

## Product Purpose

Weekmand plant het weekmenu en zet in de Picnic-mand alleen wat ontbreekt: recepten plus vaste boodschappen en extra's, min voorraad en wat er al in de mand ligt. Daarnaast houdt het de voorraad bij, laat het zien wat er echt uitgegeven wordt (budget per week, maand en jaar, per categorie, nodig tegenover extra), en geeft het een seintje vóór de Picnic-deadline. Geslaagd is het als de mand op tijd klopt zonder dat iemand alles zelf hoeft uit te rekenen.

## Positioning

Een eigen assistent die thuis op de router draait (NanoPi R4S) en niets zonder goedkeuring doet. Weekmand rekent met de echte Picnic-mand en raakt alleen zijn eigen toevoegingen aan; wat het huishouden zelf in Picnic zet, blijft staan.

## Operating Context

- Webapp in het Nederlands, telefoon eerst; op de computer dezelfde onderdelen in een zijbalk.
- Telegram-bot voor meldingen (deadline, budget, kassabonnen) en voor berichten zoals "melk is op" of een foto van een bon; antwoorden worden met de andere gekoppelde chats gedeeld.
- Picnic: mand lezen en bijwerken, bezorgmomenten, bestelgeschiedenis. Afrekenen gebeurt in de Picnic-app.
- Albert Heijn: alleen boodschappen op "Mijn lijst" zetten en kassabonnen lezen.
- Een AI-aanbieder (nu Mistral) voor chat, het indelen van producten, het koppelen van bonregels en het lezen van foto's van bonnen.
- Verder: MCP voor Claude, OpenAPI, Home Assistant via MQTT.

## Capabilities and Constraints

- Weekmand bestelt en betaalt nooit. Elke wijziging aan de echte mand gaat pas na een knop of bevestiging.
- AH-gebruik blijft beperkt tot Mijn lijst en kassabonnen (geen mand, zoeken of bestellen) om blokkering te voorkomen.
- Alle gegevens staan lokaal in SQLite en overleven een herstart; geheimen alleen in `data/secrets.json`.
- Weinig geheugen op de router: Node zonder buildstap, alleen "erasable" TypeScript, geen frontend-framework; strikte CSP (geen inline styles of scripts).

## Brand Commitments

- Naam: Weekmand. Taal: Nederlands, gewone woorden, kort.
- De webapp is een werkinstrument (Impeccable-modus Operate): bekende patronen, op de telefoon hooguit vijf tabs.

## Evidence on Hand

- Echte data van het huishouden: Picnic-bezorgingen sinds november 2023, AH-kassabonnen, voorraad, menu en recepten op de router. Niet in de repo zetten en niet in voorbeelden gebruiken.
- Screenshots in `docs/screenshots/`.
- Geen klanten, testimonials of cijfers van buiten het huishouden; die niet verzinnen.

## Product Principles

1. Weekmand stelt voor, jij keurt goed.
2. De echte mand is leidend; wat je zelf toevoegt blijft staan.
3. Lokaal en robuust: niets gaat verloren of wordt opnieuw berekend bij een herstart.
4. De telefoon gaat voor: snel te gebruiken onderweg en in de winkel.
5. Weinig, rustig verkeer naar Picnic en AH.
