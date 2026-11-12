# Front System Diagnostic (web)

Web app voor de diagnose van de **PLC96 front- en deursturing** via een USB-RS232-kabel. De app leest de 9 registers van de PLC, toont druk, lichten, deur, koppeling, sleutelschakelaar, verwarming en statuslampen, en meldt fouten met uitleg (foutcodes 11–84).

Het is één pagina zonder installatie of server-backend, en werkt offline na het eerste bezoek. Talen: Nederlands, English, Français. De diagnoseregels komen uit Front System Diagnostic V1–V5 (Qt/C++) en V6 (Android).

## Gebruik

Open de app op het GitHub Pages-adres van deze repository (zie *Publiceren*). Zonder kabel kun je op **Demo** tikken: dan draait er een gesimuleerde trein.

| Apparaat | Browser | Hoe de kabel werkt |
|---|---|---|
| Windows, macOS, Linux | Chrome of Edge | Web Serial, met het gewone stuurprogramma van de kabel |
| Android-telefoon of -tablet | Chrome | WebUSB, met een eigen driver voor Prolific PL2303 in de app |
| iPhone, Safari, Firefox | — | Alleen de demo |

**Op Android**, bijvoorbeeld met de **ACT AC6002** (USB-C naar RS232, Prolific PL2303RA):
1. Open de app via het https-adres in Chrome. Kies eventueel *App installeren*.
2. Steek de kabel in de USB-C-poort van de telefoon.
3. Tik op **Verbinden** en kies de Prolific-kabel in de lijst. Daarna verbindt de app voortaan vanzelf zodra je de kabel insteekt.
4. Werkt het niet? Op het tabblad **Registers** staat de kaart *USB-kabel*, met het chiptype, VID:PID, de revisie, de opstartstappen en het aantal bytes.

Seriële instellingen: 9600 baud, 8N1, geen flow control.

### Installeren als app (PWA)
De app is een Progressive Web App. Je installeert hem zo:
- **Android (Chrome):** menu ⋮ → **App installeren**, of de knop **App installeren** in de app zelf (kaart *Verbinding* of *Instellingen → App*).
- **Windows/macOS (Chrome of Edge):** het installatie-icoon rechts in de adresbalk.

Wat je dan krijgt:
- een eigen icoon en volledig scherm;
- **offline gebruik**, zodat de app ook werkt zonder internet in de werkplaats of op de trein;
- snelkoppelingen **Demo** en **Fouten** als je lang op het icoon drukt.

Na een update op GitHub haalt de app de nieuwe versie op de achtergrond op. Hij meldt het wanneer die klaar is; sluit en open de app dan opnieuw.

## Publiceren op GitHub Pages

De map `docs/` bevat de **kant-en-klare app**. Daardoor zijn er twee manieren, en de eerste werkt altijd.

### Manier 1: zonder Actions (eenvoudigst, ook via uploaden in de browser)
1. Maak een **openbare** repository op GitHub en upload de inhoud van deze map, of push hem met git.
2. Ga naar **Settings → Pages → Build and deployment**.
3. Kies bij **Source**: **Deploy from a branch**. Kies dan branch **main** en map **/docs**, en klik **Save**.
4. Na ongeveer een minuut staat de app op `https://<gebruiker>.github.io/<repository>/`.

Kies je toch map **/(root)**, dan stuurt `index.html` in de hoofdmap je automatisch door naar `docs/`.

### Manier 2: met GitHub Actions (test en bouwt bij elke push)
Kies bij **Source** de optie **GitHub Actions**. De workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) draait dan de tests, bouwt de app en publiceert hem.

Voorwaarde: de map `.github` moet echt op GitHub staan. Bij uploaden via de browser wordt die vaak overgeslagen, omdat Windows mappen die met een punt beginnen verbergt. Gebruik in dat geval manier 1.

```bash
git remote add origin https://github.com/<gebruiker>/<repository>.git
git push -u origin main
```

Pas je iets aan in `src/`, voer dan `npm run build:docs` uit en upload of commit ook de bijgewerkte map `docs/`.

> **Pagina laadt niet?**
> - **404:** bij *Source* staat niets of de verkeerde map, of de repository is privé op een gratis account. GitHub Pages werkt op een gratis account alleen voor openbare repositories.
> - **Leeg scherm of oude versie:** wacht een minuut. Herlaad daarna met Ctrl+F5, of op de telefoon via Chrome → ⋮ → ↻.
> - **USB:** werkt alleen via **https** (zoals github.io) of **localhost**. Dubbelklikken op `docs/index.html` toont de app wel met de demo, maar zonder USB.

## Ontwikkelen

Vereist **Node.js 26** (huidige LTS, staat in `.nvmrc`). Met `nvm use` of `fnm use` kies je automatisch de juiste versie. Er zijn geen afhankelijkheden, dus `npm install` is niet nodig.

```bash
npm test         # driver- en diagnosetests
npm run build    # bouwt dist/ (voor GitHub Actions)
npm run build:docs  # bouwt docs/ (kant-en-klaar voor GitHub Pages)
npm start        # bouwt en serveert op http://localhost:8137
```

| Pad | Inhoud |
|---|---|
| `src/core.js` | Registerindeling, protocol (`PlcConnection`), demo-PLC, Web Serial, WebUSB-driver voor PL2303, diagnoseregels |
| `src/app.html` | Interface, teksten (NL/EN/FR), instellingen |
| `src/errors/` | Uitleg per foutcode uit V1–V5 (secties `--ENG--`, `--NL--`, `--FR--`) |
| `src/sw.js`, `src/manifest.webmanifest`, `src/icon.svg`, `src/icons/`, `src/screenshots/` | PWA: offline-cache, manifest met snelkoppelingen, iconen (192, 512, maskable, Apple) en screenshot voor het installatievenster |
| `scripts/build.mjs` | Voegt alles samen tot `dist/index.html` of `docs/index.html` |
| `docs/` | Gebouwde app, klaar voor GitHub Pages (gegenereerd, niet met de hand aanpassen) |
| `index.html` | Stuurt door naar `docs/` |
| `test/pl2303.test.cjs` | Test de driver tegen een gesimuleerde PL2303-chip met de demo-PLC erachter |

### PL2303-driver
Het chiptype wordt herkend zoals in de Linux-driver (`drivers/usb/serial/pl2303.c`):
- **HX/HXD:** oude chips, USB 1.1.
- **TA/TB:** bcdDevice 0x300/0x500 en ze beantwoorden de HX-statusvraag.
- **HXN:** GC, GB, GT, GL, GE, GS, GR en RA. Product-ID 23A3…23F3, of een revisie zoals 0x305. Deze chips gebruiken vendor-requests 0x80/0x81.

De test controleert per chiptype:
- dat alleen de commando's gestuurd worden die die chip begrijpt;
- dat 9600 8N1 en DTR/RTS ingesteld worden;
- dat alle 9 registers van de demo-PLC aankomen.

### Diagnoseregels
De regels volgen `advanced.cpp` van V1–V5 en de waarheidstabel in `registers.xlsx`.
- **Foutvertraging:** een fout telt pas na een instelbare vertraging (standaard 1,5 s). Statuslampfouten (81–84) krijgen 6 s extra.
- **Geen beoordeling bij start:** de app beoordeelt pas iets als alle 9 registers binnen zijn.

## Nog te controleren op een trein
- **Echte kabel:** de verbinding met een echte PLC via Web Serial en via WebUSB.
- **Fout 83 en 84:** de app volgt V4/V5 (`NFLD`/`NCF` = 1 bij een geldige toestand). De waarheidstabel in `registers.xlsx` zegt het omgekeerde.
