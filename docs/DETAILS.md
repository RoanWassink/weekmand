# Weekmand

Lokale boodschappenassistent voor een Nederlands huishouden dat bij Picnic bestelt. Weekmand stelt een weekmenu voor, rekent uit wat er nodig is (recepten + vaste boodschappen + extra's − voorraad − wat al in de mand ligt), vult alleen het verschil aan in de Picnic-mand en seint je vóór de wijzigdeadline. Je bedient het via de webapp op je telefoon, via chat (Telegram of de webapp), via Claude of ChatGPT, of met een knop in Home Assistant.

Weekmand plaatst nooit zelf een bestelling en betaalt niets: afronden doe je in de Picnic-app.

## Wat het doet

| Onderdeel | Wat je merkt |
| --- | --- |
| Weekmenu | 49 ingebouwde recepten plus eigen recepten. Voorstel met afwisseling in keuken en eiwit, rekening met dieet, budget, recente maaltijden en een weekwens ("snel, geen vis, een keer Mexicaans"). Per dag porties aanpassen, ander gerecht kiezen of zelf kiezen. |
| Boodschappen | Telt alle recepten op (bijv. 2 + 4 + 3 eieren = 9 → doos van 10), rekent verpakkingen om ("6 x 33 cl", "ca. 1 kilo"), trekt voorraad en bestaande mandregels af. Alleen het verschil gaat de mand in; opnieuw rekenen voegt niets dubbel toe. Wat je zelf in de mand legt blijft staan. |
| Picnic | Aanmelden met sms-code, mand lezen en aanpassen, bezorgmoment en deadline, bestelgeschiedenis. Ingrediënten worden automatisch aan Picnic-producten gekoppeld; je kunt elke koppeling wijzigen. Vaste producten worden voorgesteld uit je geschiedenis. |
| Voorraad | Geschatte voorraad: leveringen erbij, gegeten maaltijden eraf. "Is op"-knoppen, barcode scannen met de camera, minimumvoorraad. Twijfelt Weekmand, dan vraagt het ("Heb je nog 6 eieren?"). |
| Chat | "We eten vrijdag met 6 man Mexicaans", "Voeg een krat pils toe en haal de kipfilet eruit", "Wat staat er deze week op het menu?". Met een gekoppelde AI in vrije tekst; zonder AI met vaste commando's. Mandwijzigingen keur je goed met de knop **Naar Picnic sturen**. |
| Proactief | Vier uur voor de Picnic-deadline: menu aanvullen, vaste producten klaarzetten, twijfelachtige voorraad navragen (ja/nee) en de mand laten goedkeuren. Via Telegram, ntfy, Home Assistant of de webapp. |
| Receptgeschiedenis | Tab **Recepten**: alle gerechten die echt besteld zijn. Duimpje omhoog zet een gerecht in de favorietenpool (komt vaker terug, "favoriet" in de weekwens geeft extra voorrang, of **Zet op menu**); duimpje omlaag met een reden houdt het voorlopig van het menu. De ochtend na een bestelde maaltijd vraagt Telegram "Hoe was de …?" (uit te zetten met `RATE_PROMPTS=off`). |
| Leren | Keur je iets twee weken achter elkaar af, dan vraagt Weekmand of het dat voortaan moet vermijden ("Je schrapt vaak vis op donderdag, zal ik dat vermijden?"). |
| Koppelingen | MCP-server voor Claude Code en Claude Desktop, OpenAPI voor een Custom GPT, MQTT met automatische ontdekking voor Home Assistant, NFC/QR-links voor "is op". |

## Starten

Node.js 24.13 of nieuwer. Node draait de TypeScript direct en levert SQLite mee.

```sh
npm ci
npm test
npm start
```

Open [Weekmand](http://127.0.0.1:8080). Zonder verdere instellingen draait alles met een demowinkel, zodat je het menu, de berekening en de goedkeuring kunt uitproberen. **Mand → Bestelling afronden (demo)** doet alsof de bestelling geleverd is; de producten gaan dan in de voorraad.

Instellingen kunnen in `.env` (zie `.env.example`) of in de webapp onder **Meer**. Sleutels en wachtwoorden invoeren kan alleen via localhost of via het subnet in `LAN_SETUP_SUBNET`.

### Picnic koppelen

**Meer → Winkel en Picnic**: meld je aan met je Picnic-account en vul de sms-code in. Vink **Sessie onthouden** aan als Weekmand na een herstart zelf moet kunnen werken (nodig voor de deadline-melding). Je wachtwoord en sms-code worden nooit bewaard; alleen de sessiesleutel komt in `data/secrets.json` (rechten 600, apart van de database). Verloopt de sessie, dan krijg je een melding.

De eerste berekening zoekt voor elk ingrediënt een passend Picnic-product en onthoudt dat. Ontbreekt een koppeling, dan zie je **Koppel** bij de boodschappen.

### AI koppelen (optioneel)

**Meer → AI-aanbieder**: Claude (Anthropic), OpenAI, Mistral, DeepSeek of een lokaal model met een OpenAI-compatibele API (bijv. Ollama). Het standaardmodel voor Claude is `claude-opus-5-5`; voor lagere kosten vul je `claude-haiku-5-5` in als model-ID. Claude loopt via de officiële Anthropic SDK; bij een weigering schakelt de API automatisch naar een terugvalmodel. Het taalmodel krijgt menu, voorraad en mandinformatie via tools, maar kan de mand niet zelf toepassen: dat gaat altijd via de knop.

### Telegram-meldingen

1. Maak een bot bij [@BotFather](https://t.me/BotFather) en kopieer het token.
2. **Meer → Telegram-meldingen**: plak het token, klik **Koppelcode maken** en stuur `/start <code>` naar je bot.
3. Probeer **Deadline-melding nu proberen**.

De bot gebruikt long polling: er hoeft geen poort open op de router. Alleen gekoppelde chats krijgen antwoord. Alternatief zonder chat: zet `NTFY_URL` op een eigen [ntfy](https://ntfy.sh)-onderwerp.

### Claude, ChatGPT en Home Assistant

**Meer → Claude, ChatGPT en Home Assistant → Toon API-token** geeft kant-en-klare instellingen:

- **Claude Code**: `claude mcp add --transport http weekmand http://<adres>:8080/mcp --header "Authorization: Bearer <token>"`
- **Claude Desktop**: `src/mcp-stdio.ts` is een brug voor stdio; de webapp toont de JSON voor `claude_desktop_config.json`.
- **ChatGPT (Custom GPT → Actions)**: importeer `/openapi.json`. ChatGPT moet Weekmand via internet kunnen bereiken; gebruik een HTTPS-tunnel (bijv. Tailscale Funnel of Cloudflare Tunnel) en zet `PUBLIC_URL`.
- **Home Assistant**: zet `MQTT_URL`. Onder het apparaat "Weekmand" verschijnen sensoren (menu vandaag/morgen, bijna op, deadline) en knoppen (weekmenu goedkeuren, mand bijwerken, nieuw menu, "<product> is op"). Een Zigbee-knop koppel je via een automatisering aan zo'n knop. Meldingen komen ook op `weekmand/notify`, zodat een automatisering ze naar de Home Assistant-app kan sturen.
- **NFC/QR**: een tag of code met `http://<adres>:8080/?op=melk` opent een bevestiging "Melk is op?".

Tools: `get_pantry_status`, `update_pantry`, `get_meal_plan`, `propose_meal_plan`, `set_meal`, `swap_meal`, `remove_meal`, `approve_meal_plan`, `find_recipes`, `get_recipe`, `get_recipe_history`, `rate_meal`, `add_to_cart`, `remove_from_cart`, `confirm_cart_update`, `review_current_cart`, `search_products`, `get_delivery_info`, `get_suggestions`, `answer_suggestion`, `set_household`. `add_to_cart` en `remove_from_cart` rekenen alleen; `confirm_cart_update` voert uit na akkoord.

### Barcode scannen

**Voorraad → Barcode scannen** maakt een foto; de decoder in de browser leest EAN-13, EAN-8 en UPC-A, ook over gewoon HTTP. De eerste keer kies je welk product het is; daarna haalt een scan direct een verpakking van de voorraad af.

## NanoPi R4S met OpenWrt

De router draait Weekmand als Node-dienst onder procd (`/opt/weekmand`). Bijwerken vanaf Windows (PowerShell 7, deploysleutel en vertrouwde hostsleutel in `.deploy/`):

```powershell
npm ci
./deploy/Update-Weekmand.ps1
```

Het script draait de tests, controleert dat alle afhankelijkheden de vastgepinde versies zijn, verpakt de app en zet een nieuwe release in `/opt/weekmand/releases`. Bij een mislukte healthcheck gaat de vorige release terug. De database (`/opt/weekmand/data`) blijft staan; de eerste start van deze versie zet de gegevens van versie 1 (huishouden, voorraad, bestelgeschiedenis) automatisch over. Extra instellingen gaan in `/opt/weekmand/config.env` (zie `.env.example`); herstart daarna met `/etc/init.d/weekmand restart`.

Geheugen: ongeveer 50–80 MB in gebruik. Met `NODE_OPTIONS=--max-old-space-size=96` in `config.env` begrens je de heap. De Anthropic SDK (21 MB op schijf) wordt alleen geladen als Claude de gekozen aanbieder is.

### Docker

```sh
docker compose up --build -d
```

Alpine-image in twee fasen, `mem_limit: 150m`, data in het volume `weekmand`. Standaard alleen op localhost; zet `BIND_IP` en `APP_PASSWORD` voor toegang vanaf het thuisnetwerk.

## Veiligheid en privacy

- Weekmand bestelt en betaalt nooit. Elke mandwijziging is zichtbaar vóór je hem goedkeurt; een tussentijds gewijzigde mand stopt de synchronisatie.
- Webapp: inloggen met een eigen account (scrypt-hash, sessiecookie van 180 dagen, korte blokkade na 5 foute pogingen). Het eerste account maak je aan vanaf het thuisnetwerk zolang er nog geen account is; daarna beheer je accounts onder **Meer → Accounts**. Gebruiker `weekmand` met `APP_PASSWORD` blijft werken. MCP, OpenAPI en Home Assistant-REST: altijd het API-token. Verzoeken van andere websites worden geweigerd.
- Geheimen (Picnic-sessie, AI-sleutel, Telegram-token, API-token) staan alleen in `data/secrets.json` en alleen als je **onthouden** aanvinkt; nooit in de database of logs.
- Naar een AI-aanbieder gaan alleen je bericht, datum en huishoudgrootte en wat de tools teruggeven (menu, voorraad, mandregels). Naar ntfy gaat alleen de meldingstekst.

## Architectuur

| Bestand | Rol |
| --- | --- |
| `src/app.ts` | Servicelaag: menu, voorraad, lijst, mandberekening, toepassen, leren, Picnic-historie |
| `src/planner.ts` | Menukeuze, behoefte optellen, verpakkingen kiezen, idempotent mandverschil met grootboek |
| `src/shop.ts` | Demowinkel, Picnic-adapter (sessie, vernieuwen, verlopen), veilig toepassen van wijzigingen |
| `src/tools.ts` | Eén toollijst voor MCP, OpenAPI, chat en Telegram |
| `src/mcp.ts`, `src/mcp-stdio.ts` | MCP over HTTP (JSON-RPC) en stdio-brug; OpenAPI |
| `src/ai.ts`, `src/assistant.ts` | Taalmodellen (Claude via SDK, OpenAI-compatibel), chat met tools, commando's zonder AI |
| `src/actions.ts`, `src/scheduler.ts` | Knoppen in meldingen, deadline-melding, periodieke taken |
| `src/telegram.ts`, `src/homeassistant.ts`, `src/mqtt.ts` | Telegram-bot, Home Assistant-discovery, MQTT-client zonder afhankelijkheden |
| `src/data/` | Ingrediënten (134, met democatalogus) en recepten (49) |
| `public/` | Mobiele webapp (installeerbaar), barcodedecoder |

## Tests

`npm test` (58 tests) dekt omrekenen en datums, de planner (overlappende ingrediënten, idempotentie, eigen mandregels, voorraadvragen, overslaan, vaste boodschappen), menu-afwisseling, het leren van afwijzingen, de Picnic-adapter met synthetische antwoorden (sms, sessie onthouden, verlopen sessie, historie, hervatten na een fout), de chat met Claude en Mistral via nagebootste API-antwoorden, de deadline-melding met ja/nee, MCP, de MQTT-client, de barcodedecoder en de HTTP-server (wachtwoord, token, CSRF). De versie van Sol staat ter vergelijking in `archief/sol-v1/`.
