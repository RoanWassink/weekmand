---
name: Weekmand
description: Boodschappenassistent voor één huishouden; telefoon eerst, rustig en scanbaar.
colors:
  basilicum: "oklch(43% 0.1 155)"
  basilicum-hover: "oklch(37% 0.1 155)"
  basilicum-tekst: "oklch(39% 0.1 155)"
  basilicum-zacht: "oklch(93.5% 0.04 150)"
  op-basilicum: "oklch(99% 0.01 145)"
  basilicumschil: "oklch(33% 0.07 158)"
  basilicumschil-donker: "oklch(29% 0.065 158)"
  op-schil: "oklch(97% 0.02 140)"
  op-schil-gedempt: "oklch(83% 0.045 145)"
  saliepapier: "oklch(97.4% 0.008 145)"
  oppervlak: "oklch(99.7% 0.003 145)"
  oppervlak-2: "oklch(95% 0.013 145)"
  lijn: "oklch(90.5% 0.014 145)"
  lijn-sterk: "oklch(84% 0.018 145)"
  inkt: "oklch(23% 0.025 155)"
  inkt-2: "oklch(46% 0.02 155)"
  tomaat: "oklch(55% 0.19 33)"
  waarschuwing: "oklch(50% 0.17 30)"
  waarschuwing-zacht: "oklch(94% 0.035 35)"
  mosterd: "oklch(51% 0.12 60)"
  mosterd-zacht: "oklch(95% 0.04 80)"
  goed: "oklch(47% 0.11 150)"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 720
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  tab-label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  sm: "9px"
  md: "10px"
  lg: "14px"
  dialog: "18px"
  pill: "999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
  tap: "44px"
components:
  button-primary:
    backgroundColor: "{colors.basilicum}"
    textColor: "{colors.op-basilicum}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.basilicum-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.basilicum-tekst}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.basilicum-tekst}"
    rounded: "{rounded.md}"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.oppervlak}"
    textColor: "{colors.inkt}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  chip:
    backgroundColor: "{colors.oppervlak}"
    textColor: "{colors.inkt}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "36px"
  chip-selected:
    backgroundColor: "{colors.basilicum}"
    textColor: "{colors.op-basilicum}"
  card:
    backgroundColor: "{colors.oppervlak}"
    rounded: "{rounded.lg}"
    padding: "16px 24px"
  nav-tab:
    textColor: "{colors.inkt-2}"
    typography: "{typography.tab-label}"
    height: "62px"
  nav-tab-active:
    textColor: "{colors.basilicum-tekst}"
  header:
    backgroundColor: "{colors.basilicumschil}"
    textColor: "{colors.op-schil}"
    height: "56px"
---

# Design System: Weekmand

## Overview

**Creative North Star: "Het weekbord in de keuken"**

Weekmand is het bord waar het huishouden de week op plant: wat er gegeten wordt, wanneer de bezorging komt en wat er nog in huis moet. Het hangt er rustig bij en je ziet in één blik waar je staat. De week loopt als een tijdlijn van boven naar beneden, en de bezorging staat erin als een markering. Het is een werkinstrument (Impeccable-modus Operate): bekende patronen, vaste plekken, en geen versiering die tussen jou en de boodschappen in staat.

De sfeer is die van een lichte keuken: een salie-getinte ondergrond, een donkergroene kopbalk als lijst om het bord, en basilicumgroen voor alles wat je kunt doen of wat actief is. Tomaatrood komt pas op het bord als het moet: de deadline nadert of er is iets mis. De dichtheid is gemiddeld. De telefoon gaat voor, en elke regel is met een duim te raken. Op de computer schuiven dezelfde onderdelen naar een zijbalk.

**Key Characteristics:**
- Telefoon eerst; vijf tabs onderin, chat rechtsboven in de kopbalk.
- De week als tijdlijn met de bezorging als markering.
- Groen voor wat je kunt doen, tomaat alleen voor tijd en urgentie, mosterd voor tekort en extra.
- Plat met dunne randen; schaduw alleen voor wat erboven ligt.
- Systeemletter, vaste rem-schaal, cijfers in kolommen tabulair.

## Colors

Een groene keuken: één accentfamilie (basilicum) op een salie-getinte ondergrond, met tomaat en mosterd als signaalkleuren die alleen iets betekenen.

### Primary
- **Basilicum** (oklch(43% 0.1 155)): hoofdknoppen, de actieve tab, geselecteerde chips, voortgangsbalken, de bezorgmarkering op de tijdlijn. Hover wordt Basilicum-donker (oklch(37% 0.1 155)).
- **Basilicum-tekst** (oklch(39% 0.1 155)): groene tekst op een lichte ondergrond (secundaire knoppen, links, actieve tablabels).
- **Basilicum-zacht** (oklch(93.5% 0.04 150)): zachte vlakken voor goed nieuws en status ("in je mand", meldingenkaarten).

### Secondary
- **Basilicumschil** (oklch(33% 0.07 158)): de kopbalk, de lijst om het bord. Basilicumschil-donker (oklch(29% 0.065 158)) voor pillen en hover in de kopbalk.

### Tertiary
- **Tomaat** (oklch(55% 0.19 33)): alleen voor tijd en urgentie: de deadline-pil als het krap wordt, het puntje voor een nieuwe melding.
- **Mosterd** (oklch(51% 0.12 60)) met Mosterd-zacht (oklch(95% 0.04 80)): "tekort" in de voorraad en "extra" (snacks, traktaties) in het budget.
- **Waarschuwing** (oklch(50% 0.17 30)) met Waarschuwing-zacht (oklch(94% 0.035 35)): fouten, boven budget, "op".

### Neutral
- **Saliepapier** (oklch(97.4% 0.008 145)): de ondergrond van elk scherm.
- **Oppervlak** (oklch(99.7% 0.003 145)) en **Oppervlak-2** (oklch(95% 0.013 145)): kaarten, lijsten en invoervelden; Oppervlak-2 voor de bak van een schakelaar en voor hover.
- **Lijn** (oklch(90.5% 0.014 145)) en **Lijn-sterk** (oklch(84% 0.018 145)): scheidingslijnen en randen van knoppen en velden.
- **Inkt** (oklch(23% 0.025 155)) en **Inkt-2** (oklch(46% 0.02 155)): tekst en bijtekst, licht groen getint in plaats van grijs.

Donker is een eigen samengestelde set (in `style.css` onder `:root[data-dark]`), niet omgekeerd: dezelfde rollen, het groen lichter en zachter, de kopbalk gaat op in het oppervlak.

**The Tomato Rule.** Tomaat betekent tijd of urgentie. Het staat nooit op een knop, kop of versiering.

**The One Green Rule.** Er is één accentfamilie. Een nieuwe status krijgt een bestaande signaalkleur, geen nieuwe tint.

## Typography

**Display Font:** geen; de koppen gebruiken de systeemletter.
**Body Font:** system-ui (met -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif)

**Character:** Eén vertrouwde systeemletter voor alles, zoals een goed ingericht hulpmiddel. Hiërarchie komt uit gewicht en maat, niet uit een tweede lettertype.

### Hierarchy
- **Headline** (720, 1.75rem, 1.15, -0.02em): schermkoppen en de bezorgdatum bovenaan Week.
- **Title** (650, 1.0625rem, 1.3): kopjes van groepen en kaarten.
- **Body** (400, 1rem, 1.5): lopende tekst en lijstregels; hints maximaal 62ch breed.
- **Label** (600, 0.875rem): knoppen, kleine knoppen, statuslabels.
- **Tab-label** (600, 0.75rem, 1.2): de labels onder de iconen in de tabbalk; nooit kleiner.

**The Tabular Rule.** Bedragen, datums en hoeveelheden die onder elkaar staan, gebruiken tabulaire cijfers.

## Layout

Een 4-px ritme (4, 8, 12, 16, 24, 32 en 48 px) met `gap` tussen broers en zussen. Op de telefoon één kolom met 16 px zijmarge; de tabbalk staat vast onderin, met ruimte voor de thuisbalk van de telefoon. Vanaf 960 px wordt de tabbalk een zijbalk van 220 px en krijgt de inhoud maximaal 52rem breedte. Lijsten groeperen met nabijheid en dunne lijnen; kaarten alleen voor een samenhangende, bedienbare groep.

**The Five Tabs Rule.** Onderin staan hooguit vijf bestemmingen (Week, Mand, Voorraad, Budget, Meer). Een nieuw onderdeel krijgt een plek binnen een bestaande tab (zoals Recepten binnen Week) of in de kopbalk (zoals Chat), geen zesde tab.

## Elevation & Depth

Plat met dunne randen. Diepte komt van de ondergrond (Saliepapier onder Oppervlak) en van 1-px lijnen, niet van schaduw. Schaduw is er alleen voor wat boven het bord ligt: de actieve knop in een schakelaar, de melding onderin, en de dialoog met een getinte achtergrond.

### Shadow Vocabulary
- **Geselecteerd** (`box-shadow: 0 1px 2px oklch(0% 0 0 / .12), 0 2px 8px oklch(0% 0 0 / .06)`): de actieve knop in een schakelaar (Menu | Recepten, Week | Maand | Jaar).
- **Zwevend** (`box-shadow: 0 6px 24px oklch(0% 0 0 / .18)`): de melding (toast) onderin.

**The Flat Board Rule.** Kaarten hebben een rand en geen schaduw. Een schaduw betekent dat iets boven het bord ligt.

## Shapes

Zacht afgeronde rechthoeken: kaarten 14 px, knoppen en velden 10 px, de knoppen in een schakelaar 9 px, dialogen 18 px. Chips, pillen en statuslabels zijn volledig rond. Iconen zijn getekend met een lijn van 1,75 tot 2 px, op 20 tot 24 px.

## Components

### Buttons
- **Shape:** zacht afgerond (10px), minstens 44 px hoog; klein 36 px.
- **Primary:** Basilicum met lichte tekst; voor de ene hoofdactie per scherm ("Opslaan", "Wijzigingen naar Picnic sturen").
- **Hover / Focus:** een tint donkerder; focus is een groene ring van 2 px met 2 px afstand.
- **Secondary:** transparant met een halfgroene rand en groene tekst. **Ghost:** zonder rand, voor rustige acties ("Bijwerken").

### Productfoto
- **Wat:** de foto van Picnic bij een product (Picnic-mand, product kiezen), zodat je ziet wélk product het is (spuitbus of bekertje).
- **Style:** 44 px vierkant, 8 px rond, 1 px Lijn, op een witte ondergrond (`--photo`, ook in het donkere thema). Zonder foto een leeg vlak in Oppervlak-2, zodat de rij op één lijn blijft.
- **Productvenster:** tik op een regel; grote foto (max. 240 px), maat, prijs per stuk en per kilo of liter, merk en omschrijving. Bij een product van Weekmand de knop "Ander product kiezen".

### Chips
- **Style:** rond, wit oppervlak met een sterke lijn, 36 px hoog.
- **State:** geselecteerd wordt Basilicum met lichte tekst; gebruikt als filter (receptenoverzicht, "is op"-knoppen).

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Oppervlak op Saliepapier.
- **Shadow Strategy:** geen (zie Elevation & Depth).
- **Border:** 1 px Lijn.
- **Internal Padding:** 16 px boven en onder, 24 px opzij.

### Inputs / Fields
- **Style:** Oppervlak, 1 px Lijn-sterk, 10 px rond, 44 px hoog; labels erboven in Inkt-2.
- **Focus:** de groene focusring; bij hover wordt de rand iets groener.

### Navigation
- **Tabbalk (telefoon):** vijf gelijke kolommen, icoon van 22 px boven een label van 0.75rem; actief in Basilicum-tekst met een groen streepje bovenaan.
- **Zijbalk (computer):** dezelfde vijf als rij met icoon en label; actief op Basilicum-zacht.
- **Kopbalk:** Basilicumschil, 56 px; naam, winkel (verborgen onder 420 px), deadline-pil en de chatknop met een tomaatpuntje voor een nieuwe melding.
- **Schakelaar:** twee of drie knoppen in een bak van Oppervlak-2; de actieve ligt erboven met de Geselecteerd-schaduw.

### De weektijdlijn (signature)
Dagen als regels met een datumblok van 56 px (dag in kapitalen, datum groot), verbonden door een verticale lijn; de bezorging staat ertussen als groene markering met een vrachtwagen. Dagen buiten de bestelling worden gedimd, lege dagen krijgen een gestippeld datumblok.

## Do's and Don'ts

### Do:
- **Do** houd één hoofdactie per scherm in Basilicum; de rest is secundair of ghost.
- **Do** gebruik Tomaat alleen voor de deadline en nieuwe meldingen (The Tomato Rule).
- **Do** zet een nieuw onderdeel binnen een bestaande tab of in de kopbalk (The Five Tabs Rule).
- **Do** gebruik tabulaire cijfers voor bedragen, datums en hoeveelheden in lijsten.
- **Do** maak elk raakbaar element minstens 44 px, ook als het teken kleiner is.

### Don't:
- **Don't** voeg een zesde tab toe of verklein de tablabels onder 0.75rem om iets te laten passen.
- **Don't** geef kaarten een schaduw; schaduw is voor wat boven het bord ligt.
- **Don't** gebruik inline `style`-attributen in HTML; de CSP blokkeert ze. Zet maten via het CSSOM of een klasse.
- **Don't** gebruik emoji of tekens als icoon; iconen zijn getekende lijn-SVG's.
- **Don't** zet twee schakelaars onder elkaar; een tweede keuze wordt chips.
