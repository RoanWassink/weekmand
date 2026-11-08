# AI en Telegram koppelen

Deze uitleg is voor wie nog nooit met een API-sleutel of een Telegram-bot heeft gewerkt. Het is optioneel. Zonder AI werkt Weekmand gewoon; de chat begrijpt dan vaste commando's zoals "menu" of "mand". Vrije tekst zoals "We eten vrijdag met zes man Mexicaans" heeft wel een AI nodig.

## Wat je nodig hebt

Een AI-dienst (een "taalmodel") is van een bedrijf zoals Mistral, DeepSeek, OpenAI of Anthropic (Claude). Om die te gebruiken heb je twee dingen nodig:

- **Een account** bij die aanbieder.
- **Een API-sleutel**: een lange tekst die bij jouw account hoort, een beetje als een wachtwoord voor de app. Wie die sleutel heeft, kan op jouw kosten AI gebruiken. Deel hem dus met niemand.

Daarnaast heb je bij de meeste aanbieders **tegoed** nodig: de sleutel werkt pas als er een betaalmethode is gekoppeld of credits zijn opgeladen. Soms is er een klein gratis tegoed; dat verschilt per aanbieder. Het gebruik voor de weekplanning is meestal goedkoop, maar bekijk de prijzen op de site van de aanbieder.

## Voorbeeld: Mistral

1. **Maak een account.** Ga naar [console.mistral.ai](https://console.mistral.ai) en maak een account aan. Je krijgt misschien een verificatie per e-mail of sms.
2. **Zet tegoed klaar.** Zoek in het menu naar **Billing** (of facturatie), voeg een betaalmethode toe en laad credits op.
3. **Maak een API-sleutel.** Zoek het menu **API Keys** en kies **Create new key**. Kopieer de sleutel meteen: je ziet hem maar één keer.
4. **Plak de sleutel in Weekmand.** Open Weekmand en ga naar **Meer → AI-aanbieder**.
   - Kies **Mistral** in de lijst.
   - Plak de sleutel bij **API-sleutel**.
   - Laat **Model-ID** leeg. Dan kiest Weekmand het standaardmodel.
   - Laat **Sleutel onthouden** aan en klik op **Testen en koppelen**. Weekmand doet dan één kleine testvraag.
5. **Controleer.** Onder "AI-aanbieder" staat nu *Actief: Mistral · [modelnaam] (opgeslagen)*. Komt er een foutmelding, controleer dan de sleutel (kopieer hem opnieuw, zonder spaties) en je tegoed.

## De andere aanbieders

Het werkt hetzelfde. Alleen de adressen en de namen van de menu's verschillen. Zoek op de naam als een adres is veranderd.

| Aanbieder | Account en sleutel | In Weekmand kiezen |
| --- | --- | --- |
| Mistral | console.mistral.ai, menu *API Keys* | Mistral |
| DeepSeek | platform.deepseek.com, menu *API keys* | DeepSeek |
| OpenAI | platform.openai.com, menu *API keys* | OpenAI |
| Claude (Anthropic) | console.anthropic.com, menu *API Keys* | Claude (Anthropic) |

Bij Claude staat het standaardmodel op claude-opus-5-5. Voor lagere kosten vul je bij **Model-ID** claude-haiku-5-5 in.

Heb je een eigen model op je netwerk, bijvoorbeeld met Ollama? Kies dan **Lokaal model**, vul het adres in (bijv. `http://192.168.1.20:11434/v1`) en heb je geen sleutel of tegoed nodig.

## Telegram-bot koppelen

Met Telegram krijg je meldingen vóór de Picnic-deadline, en je kunt Weekmand berichten sturen. De bot maak je zelf; hij is van jou.

### 1. Maak de bot

1. Open Telegram en zoek **@BotFather**. Dat is de officiële botmaker van Telegram. Tik op **Start**.
2. Stuur **/newbot**.
3. Kies een naam, bijvoorbeeld *Weekmand huis*. Kies daarna een gebruikersnaam die eindigt op **bot**, bijvoorbeeld `weekmand_huis_bot`.
4. BotFather stuurt een **token**. Kopieer alleen die regel. Een token bestaat uit twee delen met een dubbele punt ertussen:
   - **Vóór de dubbele punt**: een nummer van 5 tot 15 cijfers (het nummer van je bot).
   - **Na de dubbele punt**: een reeks van 30 tot 60 letters, cijfers, underscores (`_`) of streepjes (`-`). Geen spaties.

   Voorbeeld van de vorm (dit is géén echt token, gebruik het niet):

   `123456789:AAH-voorbeeld_NIET_ECHT_0123456789abc`

   Hoort er **niet** bij: de zin die BotFather eromheen zet ("Use this token…"), aanhalingstekens, een spatie midden in het token, of de @-naam van de bot (die begint met `@`).

   Wie het token heeft, kan de bot besturen. Deel het dus niet.

### 2. Zet de bot in Weekmand

1. Ga in Weekmand naar **Meer → Telegram-meldingen**.
2. Plak het token bij **Bottoken van @BotFather** en klik op **Instellen**.
3. Klik op **Koppelcode maken**. Er verschijnt bijvoorbeeld: *Stuur binnen 15 minuten /start 482913 naar @weekmand_huis_bot.*

### 3. Koppel je chat

1. Zoek je bot op in Telegram: typ de gebruikersnaam in de zoekbalk.
2. Tik op **Start**.
3. Plak in het tekstveld `/start`, een spatie, en de code uit de app. Dus bijvoorbeeld `/start 482913`. Stuur het bericht.
4. De bot antwoordt met *Gekoppeld!*. In Weekmand verschijnt daarna een regel **Chat …** onder Telegram-meldingen.
5. Test het met **Testbericht**, of met **Deadline-melding nu proberen**.

De code is 15 minuten geldig. Lukt het niet, klik dan opnieuw op **Koppelcode maken**.

## Veelvoorkomende fouten

- **"Dit lijkt geen Telegram-bottoken"**: het token is niet compleet gekopieerd. Stuur bij BotFather `/token` om het opnieuw te krijgen.
- **"Vul een geldige API-sleutel in"**: de sleutel is te kort of bevat spaties. Kopieer hem opnieuw.
- **Testen mislukt bij de AI**: er is geen tegoed, of de sleutel klopt niet. Maak een nieuwe sleutel als je twijfelt.
- **De bot zegt "Deze bot hoort bij een privé Weekmand"**: de code klopt niet of is verlopen. Klik in Weekmand opnieuw op **Koppelcode maken** en gebruik de nieuwe code.

## Wat gaat er naar de AI?

Je bericht, de datum, het aantal personen in het huishouden, en wat Weekmand opzoekt (menu, voorraad, mand). Wachtwoorden en de Picnic-sessie gaan er nooit heen.

De AI-sleutel wordt alleen opgeslagen als je **Sleutel onthouden** aanvinkt. Het Telegram-token wordt altijd opgeslagen, zodat de bot na een herstart blijft werken. Beide staan in een apart bestand (`data/secrets.json`), niet in de database.

Deze koppelingen stel je in vanaf de computer waarop Weekmand draait, of vanaf het thuisnetwerk waarvoor dat is ingesteld.
