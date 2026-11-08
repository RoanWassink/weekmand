# Weekmand

Lokale boodschappenassistent voor een Nederlands huishouden dat bij Picnic bestelt. Weekmand stelt een weekmenu voor, rekent uit wat er nodig is (recepten + vaste boodschappen + extra's − voorraad − wat al in de mand ligt), vult alleen het verschil aan in de Picnic-mand en seint je vóór de wijzigdeadline. Je bedient het via de webapp op je telefoon, via chat (Telegram of de webapp), via Claude of ChatGPT, of met een knop in Home Assistant.

Weekmand plaatst nooit zelf een bestelling en betaalt niets: afronden doe je in de Picnic-app.

## Wat het doet

| Onderdeel | Wat je merkt |
| --- | --- |
| Weekmenu | 49 ingebouwde recepten plus eigen recepten. Voorstel met afwisseling in keuken en eiwit, rekening met dieet, budget, recente maaltijden en een weekwens ("snel, geen vis, een keer Mexicaans"). Per dag porties aanpassen, ander gerecht kiezen of zelf kiezen. |
| Boodschappen | Telt alle recepten op (bijv. 2 + 4 + 3 eieren = 9 → doos van 10), rekent verpakkingen om ("6 x 33 cl", "ca. 1 kilo"), trekt voorraad en bestaande mandregels af. Alleen het verschil gaat de mand in; opnieuw rekenen voegt niets dubbel toe. Wat je zelf in de mand legt blijft staan. Een regel wegvegen of iets op de lijst zetten werkt meteen: Weekmand rekent met de Picnic-mand die het al gelezen heeft (hooguit 10 minuten oud; het tijdstip staat bij het voorstel). **Opnieuw berekenen** leest de mand vers, en vóór het doorvoeren leest Weekmand hem altijd opnieuw. |
| Picnic | Aanmelden met sms-code, mand lezen en aanpassen, bezorgmoment en deadline, bestelgeschiedenis. Ingrediënten worden automatisch aan Picnic-producten gekoppeld; je kunt elke koppeling wijzigen. Vaste producten worden voorgesteld uit je geschiedenis. |
| Voorraad | Geschatte voorraad: leveringen erbij, gegeten maaltijden eraf. "Is op"-knoppen, barcode scannen met de camera, minimumvoorraad. Bij het menu staat per ingrediënt of het genoeg is, al in je mand ligt of nog besteld moet worden. Boven elke lange lijst (voorraad, voorstel, Picnic-mand) staat een zoekveld dat filtert terwijl je typt. Twijfelt Weekmand, dan vraagt het ("Heb je nog 6 eieren?"). |
| Chat | Rechtsboven in de kopbalk, met een puntje bij een nieuwe melding. "We eten vrijdag met 6 man Mexicaans", "Voeg een krat pils toe en haal de kipfilet eruit", "Wat staat er deze week op het menu?". Met een gekoppelde AI in vrije tekst; zonder AI met vaste commando's. Mandwijzigingen keur je goed met de knop **Naar Picnic sturen**. Typ je zelf "naar Picnic sturen" of "stuur maar", dan laat Weekmand (niet de AI) zien wat er echt klaarstaat, met die knop. Noemt de AI een ingrediënt zonder product, dan kan hij er een koppelen (tool `link_product`), en een gekozen product gaat met zijn id mee. |
| Proactief | Vier uur voor de Picnic-deadline: menu aanvullen, vaste producten klaarzetten, twijfelachtige voorraad navragen (ja/nee) en de mand laten goedkeuren. Via Telegram, ntfy, Home Assistant of de webapp. |
| Receptgeschiedenis | **Week → Recepten**: alle gerechten die echt besteld zijn. Duimpje omhoog zet een gerecht in de favorietenpool (komt vaker terug, "favoriet" in de weekwens geeft extra voorrang, of **Zet op menu**); duimpje omlaag met een reden houdt het voorlopig van het menu. De ochtend na een bestelde maaltijd vraagt Telegram "Hoe was de …?" (uit te zetten met `RATE_PROMPTS=off`). |
| Recept importeren | **Week → Recepten → Alle**: plak een link naar een receptpagina. Weekmand leest het schema.org-recept, rekent de hoeveelheden om naar per persoon in de eenheden van de catalogus en laat eerst een voorbeeld zien. Daarin kun je regels uitvinken; nieuwe ingrediënten worden toegevoegd. Werkt niet voor sites die het recept pas in de browser opbouwen (Plus) of automatische bezoekers weren (Allerhande). Plak dan de ingrediëntenlijst zelf (**Ingrediënten plakken**). Ook als tool `import_recipe` voor chat en MCP. Links naar het eigen netwerk worden geweigerd. |
| Albert Heijn | Voor boodschappen in de AH-winkel. Weekmand zet de boodschappen op Mijn lijst in de AH-app (zelfscanner) en telt kassabonnen bij de voorraad. Ook als tools `send_to_ah_list` en `import_ah_receipts`. Zie [Albert Heijn koppelen](#albert-heijn-koppelen-optioneel-voor-de-winkel). |
| Budget | Tab **Budget**: wat je echt uitgaf per week, maand en jaar, tegenover een maandbudget. Bronnen: Picnic-bezorgingen en AH-kassabonnen van de afgelopen drie jaar (totalen meteen, de producten per bon rustig, een paar per uur) en losse uitgaven die je zelf invoert (markt, bakker). Per categorie, nodig tegenover extra (snacks, snoep, alcohol) en geen eten, per winkel, de grootste posten, wat duurder werd, bespaard met acties, kosten per persoon per dag en een koers voor de rest van de periode. Limiet per categorie, een bon niet laten meetellen, export als CSV. Zie [Budget](#budget). |
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

### Albert Heijn koppelen (optioneel, voor de winkel)

Weekmand gebruikt je AH-account voor twee dingen:

- **Mijn lijst:** in de tab **Mand** zet **Op mijn AH-lijst zetten** de boodschappen op Mijn lijst in de AH-app, zodat je ze in de winkel en in de zelfscanner ziet.
  - Het gaat om wat Weekmand nog wil kopen en niet al in de Picnic-mand zit. Je kunt regels uitvinken en zelf iets toevoegen.
  - Wat al op de lijst staat (niet afgestreept), slaat Weekmand over.
- **Kassabonnen:** elke vier uur haalt Weekmand nieuwe kassabonnen op en telt de producten bij de voorraad. Met **Voorraad → Kassabonnen van AH ophalen** kan het meteen.
  - Elke bon telt één keer. Statiegeld en tasjes tellen niet mee.
  - De bon noemt geen maat. Weekmand leest die uit de productnaam ("400G"), of telt één gewone verpakking.
  - Bonregels zijn afgekort ("TOMAATBLOKJE", "KL KEUKEN"). Wat Weekmand zelf niet herkent, legt het voor aan de gekoppelde AI. De AI kiest een bestaand ingrediënt, maakt een nieuw ingrediënt aan (alleen eten en drinken) of markeert de regel als geen boodschap (keukenrol, vuilniszakken). Waar mogelijk schat de AI ook de inhoud van één stuk. Naar de AI gaan alleen de bonregels en de namen van de ingrediënten.
  - Weekmand onthoudt elke koppeling, dus dezelfde regel op een volgende bon kost geen AI meer.
  - Wat ook de AI niet kent, koppel of negeer je zelf onder **Meer → Albert Heijn**. Daarna telt Weekmand die regels van recente bonnen alsnog bij de voorraad.

Weekmand bestelt niets bij AH, vult geen AH-mand en zoekt geen producten.

Koppelen gaat op een computer, onder **Meer → Albert Heijn**:

1. Open in Chrome of Edge de inlogpagina van AH via de link in Weekmand.
2. Druk in dat tabblad op **F12**, kies **Network** (Netwerk) en typ `ingelogd` in het filterveld. Doe dit vóór je inlogt.
3. Log in en vul de sms-code in. Het scherm blijft daarna hangen met een draaiend rondje. Dat is normaal: de pagina probeert de AH-app te openen.
4. Klik in de lijst op `ingelogd.json` en kies **Response** (Reactie). Daar staat `{"pageProps":{"__N_REDIRECT":"appie://login-exit?code=…"}}`.
5. Kopieer die tekst (Ctrl+A, Ctrl+C), plak hem in Weekmand en klik op **Koppelen**. Weekmand haalt de code eruit. De code werkt één keer en maar een paar minuten.

Staat er geen `ingelogd.json` in de lijst, dan stond F12 nog niet open tijdens het inloggen. Laat F12 open, ververs de inlogpagina en log opnieuw in. In de console verschijnt de code niet (gecontroleerd op 7 november 2026).

Weekmand ziet je AH-wachtwoord niet. Alleen de tokens komen in `data/secrets.json`. Bij het koppelen tellen de kassabonnen van de afgelopen drie dagen mee.

AH heeft geen openbare API. Weekmand gebruikt de API van de AH-app, zoals community-projecten die beschrijven. Dat kan zonder aankondiging stoppen met werken. Weekmand houdt het aantal verzoeken laag en stuurt een eerlijke User-Agent. Weigert AH (403 of 429), dan wacht Weekmand twaalf uur. Verloopt de koppeling, dan krijg je een melding.

### AI koppelen (optioneel)

**Meer → AI-aanbieder**: Claude (Anthropic), OpenAI, Mistral, DeepSeek of een lokaal model met een OpenAI-compatibele API (bijv. Ollama). Het standaardmodel voor Claude is `claude-opus-5-5`; voor lagere kosten vul je `claude-haiku-5-5` in als model-ID. Claude loopt via de officiële Anthropic SDK; bij een weigering schakelt de API automatisch naar een terugvalmodel. Het taalmodel krijgt menu, voorraad en mandinformatie via tools, maar kan de mand niet zelf toepassen: dat gaat altijd via de knop.

### Telegram-meldingen

1. Maak een bot bij [@BotFather](https://t.me/BotFather) en kopieer het token.
2. **Meer → Telegram-meldingen**: plak het token, klik **Koppelcode maken** en stuur `/start <code>` naar je bot.
3. Probeer **Deadline-melding nu proberen**.

Stuur een foto van een kassabon, dan leest Weekmand hem en vraagt of hij in het budget mag (zie [Budget](#budget)). Iedereen in huis kan een eigen chat koppelen (elke koppelcode werkt één keer). Wat de bot in de ene chat antwoordt, lezen de anderen mee, met de naam van wie het vroeg ("Roan: melk is op"). Standaard alleen als er iets veranderde (voorraad, menu, lijst, mand); onder **Meer → Telegram** kies je ook "alles, ook vragen" of "niets". Wat je in de chat van de webapp verandert, gaat ook naar Telegram.

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

## Budget

De tab **Budget** telt wat er werkelijk uitgegeven is, los van wat Weekmand voorstelt.

- **Bronnen.** Elk uur haalt Weekmand nieuwe Picnic-bezorgingen en AH-kassabonnen op, tot drie jaar terug. Totalen zijn er meteen. De producten per bon volgen rustig, een paar per uur, nieuwste eerst; **Bijwerken** haalt er meteen een stuk meer. Tot dan staat dat bedrag onder "Nog niet uitgesplitst". Bezorgkosten, statiegeld en korting staan apart.
- **Indelen.** Elk product krijgt een categorie en een soort: *nodig*, *extra* (snoep, chips, frisdrank, alcohol, gebak) of *geen eten* (schoonmaak, verzorging). Volgorde: je eigen keuze, dan de AI, dan vaste woorden (pils, chips, toiletpapier), dan de ingrediëntencatalogus. Wat niemand kent, telt als nodig in "Overig" tot de AI of jij het indeelt. Tik een product om het te wijzigen; dat geldt ook voor eerdere perioden. Naar de AI gaan alleen productnamen.
- **AH-bonus.** De bonusregels onderaan een kassabon ("BONUS AHRUNDERGEHA -0,40") koppelt Weekmand op naam aan het product (RUNDERGEHAKT). Dat product telt dan mee met wat je echt betaalde, en de korting telt bij "Bespaard met acties". De bon zegt niet welk product de korting kreeg; een onduidelijke regel blijft los, en telt alleen als besparing. Oudere bonnen worden een keer opnieuw opgehaald voor hun bonusregels.
- **Foto van een bon.** Voor bonnen van andere winkels (Lidl, Jumbo, markt): **Budget → Foto van bon**, of stuur de foto naar de Telegram-bot. De AI leest winkel, datum, totaal, regels en kortingen. Jij controleert het eerst: in de webapp kun je winkel, datum en totaal aanpassen en regels weglaten; in Telegram kies je **Opslaan**, **Opslaan + voorraad** of **Weggooien**. Weekmand waarschuwt als de regels niet optellen tot het totaal, en als dezelfde bon (dag en bedrag) er al staat. Foto's lezen kan met Claude, OpenAI en Mistral. Kan het gekozen Mistral-model geen foto's lezen, dan gebruikt Weekmand daarvoor `mistral-medium-latest`. DeepSeek leest geen foto's.
- **Budget.** Standaard afgeleid van het mandbudget per bestelling (× 52 / 12). Met een eigen maandbudget krijg je een seintje bij 80% en 100%, ook via Telegram. Een limiet per categorie zet je in de uitgeklapte categorie.
- **Ook:** losse uitgaven (min-bedrag is een terugbetaling), een bon niet laten meetellen, **Alle uitgaven downloaden (CSV)** voor een spreadsheet, en de vraag in de chat ("hoeveel gaven we deze maand uit aan snacks?", tool `get_budget`).

### Wat een herstart overleeft

Alles wat Weekmand ophaalt of leert staat in de database (`data/weekmand.sqlite`) en wordt na een herstart niet opnieuw opgehaald of berekend:
- aankopen en hun regels;
- bonusregels;
- productindeling (eigen keuze en AI);
- bonnen die in Telegram op **Opslaan** wachten;
- wanneer er voor het laatst bij Picnic en AH is gekeken;
- de 12 uur rust na een weigering door AH;
- het laatst verwerkte Telegram-bericht, zodat een bericht nooit twee keer wordt uitgevoerd;
- de laatste mandberekening.

De mandberekening wordt na een herstart alleen opnieuw gemaakt als hij ouder is dan tien minuten of als er intussen iets veranderde. Voor elke update maakt de uitrol een kopie van de map `data`.

De AI deelt producten in porties van 25 in. Een product dat geen antwoord krijgt, probeert Weekmand nog twee keer; daarna alleen nog als je zelf op **Laat de AI indelen** tikt.

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
- Geheimen (Picnic-sessie, AH-tokens, AI-sleutel, Telegram-token, API-token) staan alleen in `data/secrets.json` en alleen als je **onthouden** aanvinkt; nooit in de database of logs.
- Naar een AI-aanbieder gaan alleen je bericht, datum en huishoudgrootte en wat de tools teruggeven (menu, voorraad, mandregels); voor de bonnen en het budget alleen productnamen. Een foto van een bon gaat naar de AI-aanbieder om te lezen; Weekmand bewaart de foto zelf niet. Naar ntfy gaat alleen de meldingstekst.

## Architectuur

| Bestand | Rol |
| --- | --- |
| `src/app.ts` | Servicelaag: menu, voorraad, lijst, mandberekening, toepassen, leren, Picnic-historie, AH, budget |
| `src/budget.ts` | Budget: perioden, optellen per categorie en soort, prijsstijgingen, CSV |
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
