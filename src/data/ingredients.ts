// Ingrediëntencatalogus met democatalogus-verpakkingen (prijzen in centen, indicatief 2026).
import type { IngredientDef } from '../types.ts';

export const ingredients: IngredientDef[] = [
  {
    key: 'ui', name: 'Uien', unit: 'st', pieceGrams: 100, category: 'groente-fruit',
    query: 'uien', aliases: ['ui', 'uitjes'],
    packs: [
      { id: 'ui-10', name: 'Uien 1 kg (ca. 10 st)', amount: 10, unit: 'st', cents: 189 },
      { id: 'ui-6', name: 'Uien 6 st', amount: 6, unit: 'st', cents: 139 },
    ],
  },
  {
    key: 'knoflook', name: 'Knoflook (teentjes)', unit: 'st', pieceGrams: 5, category: 'groente-fruit',
    query: 'knoflook', aliases: ['knoflookteen', 'teentje knoflook'],
    packs: [
      { id: 'knoflook-10', name: 'Knoflook 1 bol (ca. 10 teentjes)', amount: 10, unit: 'st', cents: 89 },
      { id: 'knoflook-30', name: 'Knoflook 3 bollen', amount: 30, unit: 'st', cents: 199 },
    ],
  },
  {
    key: 'paprika', name: 'Paprika', unit: 'st', pieceGrams: 150, category: 'groente-fruit',
    query: 'paprika', aliases: ['paprika\'s'],
    packs: [
      { id: 'paprika-1', name: 'Paprika rood 1 st', amount: 1, unit: 'st', cents: 109 },
      { id: 'paprika-3', name: 'Paprika mix 3 st', amount: 3, unit: 'st', cents: 249 },
    ],
  },
  {
    key: 'tomaat', name: 'Tomaten', unit: 'st', pieceGrams: 100, category: 'groente-fruit',
    query: 'tomaten', aliases: ['tomaten', 'tomaatjes'],
    packs: [
      { id: 'tomaat-6', name: 'Tomaten 6 st', amount: 6, unit: 'st', cents: 219 },
      { id: 'tomaat-4', name: 'Trostomaten 4 st', amount: 4, unit: 'st', cents: 189 },
    ],
  },
  {
    key: 'cherrytomaat', name: 'Cherrytomaten', unit: 'g', category: 'groente-fruit',
    query: 'cherrytomaten', aliases: ['tomaatjes'],
    packs: [
      { id: 'cherrytomaat-250', name: 'Cherrytomaten 250 g', amount: 250, unit: 'g', cents: 229 },
      { id: 'cherrytomaat-500', name: 'Cherrytomaten 500 g', amount: 500, unit: 'g', cents: 419 },
    ],
  },
  {
    key: 'wortel', name: 'Wortelen', unit: 'st', pieceGrams: 80, category: 'groente-fruit',
    query: 'winterwortel', aliases: ['peen', 'wortels'],
    packs: [
      { id: 'wortel-6', name: 'Wortelen 500 g (ca. 6 st)', amount: 6, unit: 'st', cents: 99 },
      { id: 'wortel-12', name: 'Winterpeen 1 kg (ca. 12 st)', amount: 12, unit: 'st', cents: 149 },
    ],
  },
  {
    key: 'courgette', name: 'Courgette', unit: 'st', pieceGrams: 300, category: 'groente-fruit',
    query: 'courgette',
    packs: [
      { id: 'courgette-1', name: 'Courgette 1 st', amount: 1, unit: 'st', cents: 99 },
      { id: 'courgette-2', name: 'Courgette 2 st', amount: 2, unit: 'st', cents: 179 },
    ],
  },
  {
    key: 'komkommer', name: 'Komkommer', unit: 'st', pieceGrams: 400, category: 'groente-fruit',
    query: 'komkommer',
    packs: [
      { id: 'komkommer-1', name: 'Komkommer 1 st', amount: 1, unit: 'st', cents: 89 },
    ],
  },
  {
    key: 'prei', name: 'Prei', unit: 'st', pieceGrams: 250, category: 'groente-fruit',
    query: 'prei',
    packs: [
      { id: 'prei-1', name: 'Prei 1 st', amount: 1, unit: 'st', cents: 129 },
      { id: 'prei-3', name: 'Prei 3 st', amount: 3, unit: 'st', cents: 299 },
    ],
  },
  {
    key: 'broccoli', name: 'Broccoli', unit: 'st', pieceGrams: 400, category: 'groente-fruit',
    query: 'broccoli',
    packs: [
      { id: 'broccoli-1', name: 'Broccoli 1 st', amount: 1, unit: 'st', cents: 159 },
      { id: 'broccoli-2', name: 'Broccoli 2 st', amount: 2, unit: 'st', cents: 289 },
    ],
  },
  {
    key: 'aubergine', name: 'Aubergine', unit: 'st', pieceGrams: 300, category: 'groente-fruit',
    query: 'aubergine',
    packs: [
      { id: 'aubergine-1', name: 'Aubergine 1 st', amount: 1, unit: 'st', cents: 139 },
    ],
  },
  {
    key: 'avocado', name: 'Avocado', unit: 'st', pieceGrams: 170, category: 'groente-fruit',
    query: 'avocado eetrijp', aliases: ['avocado\'s'],
    packs: [
      { id: 'avocado-1', name: 'Avocado 1 st', amount: 1, unit: 'st', cents: 139 },
      { id: 'avocado-2', name: 'Avocado eetrijp 2 st', amount: 2, unit: 'st', cents: 249 },
    ],
  },
  {
    key: 'citroen', name: 'Citroen', unit: 'st', pieceGrams: 100, category: 'groente-fruit',
    query: 'citroenen', aliases: ['citroenen'],
    packs: [
      { id: 'citroen-1', name: 'Citroen 1 st', amount: 1, unit: 'st', cents: 69 },
      { id: 'citroen-3', name: 'Citroenen 3 st', amount: 3, unit: 'st', cents: 179 },
    ],
  },
  {
    key: 'limoen', name: 'Limoen', unit: 'st', pieceGrams: 70, category: 'groente-fruit',
    query: 'limoenen', aliases: ['limoenen'],
    packs: [
      { id: 'limoen-2', name: 'Limoenen 2 st', amount: 2, unit: 'st', cents: 149 },
    ],
  },
  {
    key: 'banaan', name: 'Bananen', unit: 'st', pieceGrams: 120, category: 'groente-fruit',
    query: 'bananen', aliases: ['bananen'],
    packs: [
      { id: 'banaan-5', name: 'Bananen 5 st', amount: 5, unit: 'st', cents: 199 },
      { id: 'banaan-8', name: 'Bananen 8 st', amount: 8, unit: 'st', cents: 299 },
    ],
  },
  {
    key: 'appel', name: 'Appels', unit: 'st', pieceGrams: 180, category: 'groente-fruit',
    query: 'appels', aliases: ['appels', 'appeltjes'],
    packs: [
      { id: 'appel-6', name: 'Appels 6 st', amount: 6, unit: 'st', cents: 249 },
      { id: 'appel-10', name: 'Appels 10 st', amount: 10, unit: 'st', cents: 389 },
    ],
  },
  {
    key: 'mandarijn', name: 'Mandarijnen', unit: 'st', pieceGrams: 60, category: 'groente-fruit',
    query: 'mandarijnen', aliases: ['mandarijnen', 'mandarijntjes'],
    packs: [
      { id: 'mandarijn-6', name: 'Mandarijnen 6 st', amount: 6, unit: 'st', cents: 199 },
      { id: 'mandarijn-15', name: 'Mandarijnen 15 st', amount: 15, unit: 'st', cents: 329 },
    ],
  },
  {
    key: 'spinazie', name: 'Spinazie', unit: 'g', category: 'groente-fruit',
    query: 'spinazie',
    packs: [
      { id: 'spinazie-250', name: 'Spinazie 250 g', amount: 250, unit: 'g', cents: 179 },
    ],
  },
  {
    key: 'champignon', name: 'Champignons', unit: 'g', category: 'groente-fruit',
    query: 'champignons', aliases: ['champignons'],
    packs: [
      { id: 'champignon-250', name: 'Champignons 250 g', amount: 250, unit: 'g', cents: 179 },
      { id: 'champignon-500', name: 'Champignons 500 g', amount: 500, unit: 'g', cents: 299 },
    ],
  },
  {
    key: 'sperziebonen', name: 'Sperziebonen', unit: 'g', category: 'groente-fruit',
    query: 'sperziebonen', aliases: ['boontjes'],
    packs: [
      { id: 'sperziebonen-400', name: 'Sperziebonen 400 g', amount: 400, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'bloemkool', name: 'Bloemkool', unit: 'st', pieceGrams: 600, category: 'groente-fruit',
    query: 'bloemkool',
    packs: [
      { id: 'bloemkool-1', name: 'Bloemkool 1 st', amount: 1, unit: 'st', cents: 199 },
    ],
  },
  {
    key: 'andijvie', name: 'Andijvie', unit: 'g', category: 'groente-fruit',
    query: 'andijvie',
    packs: [
      { id: 'andijvie-400', name: 'Andijvie 400 g', amount: 400, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'zuurkool', name: 'Zuurkool', unit: 'g', category: 'groente-fruit',
    query: 'zuurkool',
    packs: [
      { id: 'zuurkool-520', name: 'Zuurkool 520 g', amount: 520, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'sla', name: 'Gemengde sla', unit: 'g', pieceGrams: 250, category: 'groente-fruit',
    query: 'gemengde sla', aliases: ['salade', 'sla'],
    packs: [
      { id: 'sla-200', name: 'Gemengde sla 200 g', amount: 200, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'rucola', name: 'Rucola', unit: 'g', category: 'groente-fruit',
    query: 'rucola',
    packs: [
      { id: 'rucola-60', name: 'Rucola 60 g', amount: 60, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'peterselie', name: 'Verse peterselie', unit: 'g', category: 'groente-fruit',
    query: 'verse peterselie', aliases: ['peterselie'],
    packs: [
      { id: 'peterselie-30', name: 'Verse peterselie 30 g', amount: 30, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'gember', name: 'Verse gember', unit: 'g', category: 'groente-fruit',
    query: 'gember', aliases: ['gember'],
    packs: [
      { id: 'gember-100', name: 'Gember 100 g', amount: 100, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'aardappelen', name: 'Aardappelen', unit: 'g', category: 'aardappel',
    query: 'kruimige aardappelen', aliases: ['piepers', 'aardappels', 'patat'],
    packs: [
      { id: 'aardappelen-1000', name: 'Kruimige aardappelen 1 kg', amount: 1000, unit: 'g', cents: 179 },
      { id: 'aardappelen-2500', name: 'Aardappelen 2,5 kg', amount: 2500, unit: 'g', cents: 399 },
    ],
  },
  {
    key: 'krieltjes', name: 'Krieltjes', unit: 'g', category: 'aardappel',
    query: 'krieltjes',
    packs: [
      { id: 'krieltjes-750', name: 'Krieltjes 750 g', amount: 750, unit: 'g', cents: 279 },
    ],
  },
  {
    key: 'kipfilet', name: 'Kipfilet', unit: 'g', category: 'vlees',
    query: 'kipfilet', aliases: ['kip', 'kippenborst', 'kippenfilet'],
    packs: [
      { id: 'kipfilet-300', name: 'Kipfilet 300 g', amount: 300, unit: 'g', cents: 459 },
      { id: 'kipfilet-600', name: 'Kipfilet 600 g', amount: 600, unit: 'g', cents: 849 },
    ],
  },
  {
    key: 'kippendij', name: 'Kippendijfilet', unit: 'g', category: 'vlees',
    query: 'kippendijfilet', aliases: ['kippendij', 'kipdijfilet', 'kipdij'],
    packs: [
      { id: 'kippendij-400', name: 'Kippendijfilet 400 g', amount: 400, unit: 'g', cents: 469 },
    ],
  },
  {
    key: 'kipshoarma', name: 'Kipshoarma', unit: 'g', category: 'vlees',
    query: 'kipshoarma', aliases: ['shoarma'],
    packs: [
      { id: 'kipshoarma-300', name: 'Kipshoarma 300 g', amount: 300, unit: 'g', cents: 459 },
    ],
  },
  {
    key: 'gehakt', name: 'Gehakt half om half', unit: 'g', category: 'vlees',
    query: 'gehakt half om half', aliases: ['gehakt', 'halfomhalf'],
    packs: [
      { id: 'gehakt-500', name: 'Gehakt half om half 500 g', amount: 500, unit: 'g', cents: 459 },
    ],
  },
  {
    key: 'rundergehakt', name: 'Rundergehakt', unit: 'g', category: 'vlees',
    query: 'rundergehakt', aliases: ['rundvleesgehakt'],
    packs: [
      { id: 'rundergehakt-250', name: 'Rundergehakt 250 g', amount: 250, unit: 'g', cents: 329 },
      { id: 'rundergehakt-500', name: 'Rundergehakt 500 g', amount: 500, unit: 'g', cents: 599 },
    ],
  },
  {
    key: 'runderstoofvlees', name: 'Runderstoofvlees', unit: 'g', category: 'vlees',
    query: 'runderstoofvlees', aliases: ['stoofvlees', 'hachee vlees'],
    packs: [
      { id: 'runderstoofvlees-400', name: 'Runderstoofvlees 400 g', amount: 400, unit: 'g', cents: 699 },
    ],
  },
  {
    key: 'rundervinken', name: 'Runderreepjes', unit: 'g', category: 'vlees',
    query: 'runderreepjes', aliases: ['biefstukreepjes', 'beef'],
    packs: [
      { id: 'rundervinken-250', name: 'Runderreepjes 250 g', amount: 250, unit: 'g', cents: 549 },
    ],
  },
  {
    key: 'varkenslappen', name: 'Varkenslapjes', unit: 'g', category: 'vlees',
    query: 'varkenslapjes', aliases: ['varkensvlees', 'lapjes'],
    packs: [
      { id: 'varkenslappen-400', name: 'Varkenslapjes 400 g', amount: 400, unit: 'g', cents: 479 },
    ],
  },
  {
    key: 'rookworst', name: 'Rookworst', unit: 'g', category: 'vlees',
    query: 'rookworst',
    packs: [
      { id: 'rookworst-275', name: 'Rookworst 275 g', amount: 275, unit: 'g', cents: 299 },
    ],
  },
  {
    key: 'spekblokjes', name: 'Spekblokjes', unit: 'g', category: 'vlees',
    query: 'spekblokjes', aliases: ['spek', 'spekjes'],
    packs: [
      { id: 'spekblokjes-200', name: 'Spekblokjes 200 g', amount: 200, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'ham', name: 'Achterham', unit: 'g', category: 'vlees',
    query: 'achterham', aliases: ['ham', 'geroosterde ham'],
    packs: [
      { id: 'ham-100', name: 'Achterham 100 g', amount: 100, unit: 'g', cents: 229 },
    ],
  },
  {
    key: 'zalm', name: 'Zalmfilet', unit: 'g', category: 'vis',
    query: 'zalmfilet', aliases: ['zalm'],
    packs: [
      { id: 'zalm-250', name: 'Zalmfilet 2 st 250 g', amount: 250, unit: 'g', cents: 599 },
      { id: 'zalm-500', name: 'Zalmfilet 4 st 500 g', amount: 500, unit: 'g', cents: 1099 },
    ],
  },
  {
    key: 'kabeljauw', name: 'Kabeljauwfilet', unit: 'g', category: 'vis',
    query: 'kabeljauwfilet', aliases: ['kabeljauw', 'witvis'],
    packs: [
      { id: 'kabeljauw-250', name: 'Kabeljauwfilet 250 g', amount: 250, unit: 'g', cents: 549 },
    ],
  },
  {
    key: 'garnalen', name: 'Garnalen', unit: 'g', category: 'vis',
    query: 'garnalen',
    packs: [
      { id: 'garnalen-200', name: 'Garnalen 200 g', amount: 200, unit: 'g', cents: 599 },
    ],
  },
  {
    key: 'tonijn', name: 'Tonijn in water', unit: 'g', category: 'vis',
    query: 'tonijn in water', aliases: ['tonijn'],
    packs: [
      { id: 'tonijn-145', name: 'Tonijn in water 145 g', amount: 145, unit: 'g', cents: 189 },
    ],
  },
  {
    key: 'gerookte-zalm', name: 'Gerookte zalm', unit: 'g', category: 'vis',
    query: 'gerookte zalm',
    packs: [
      { id: 'gerookte-zalm-100', name: 'Gerookte zalm 100 g', amount: 100, unit: 'g', cents: 399 },
    ],
  },
  {
    key: 'visstaafjes', name: 'Visstaafjes', unit: 'g', category: 'vis',
    query: 'visstaafjes', aliases: ['vissticks', 'visstick'],
    packs: [
      { id: 'visstaafjes-300', name: 'Visstaafjes 300 g', amount: 300, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'tofu', name: 'Tofu naturel', unit: 'g', category: 'vega',
    query: 'tofu naturel', aliases: ['tofu'],
    packs: [
      { id: 'tofu-200', name: 'Tofu naturel 200 g', amount: 200, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'vegagehakt', name: 'Vegetarisch gehakt', unit: 'g', category: 'vega',
    query: 'vegetarisch gehakt', aliases: ['vegagehakt'],
    packs: [
      { id: 'vegagehakt-200', name: 'Vegetarisch gehakt 200 g', amount: 200, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'falafel', name: 'Falafel', unit: 'g', category: 'vega',
    query: 'falafel',
    packs: [
      { id: 'falafel-250', name: 'Falafel 250 g', amount: 250, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'melk', name: 'Halfvolle melk', unit: 'ml', category: 'zuivel-eieren',
    query: 'halfvolle melk', aliases: ['melk'],
    packs: [
      { id: 'melk-1000', name: 'Halfvolle melk 1 L', amount: 1000, unit: 'ml', cents: 129 },
      { id: 'melk-2000', name: 'Halfvolle melk 2 L', amount: 2000, unit: 'ml', cents: 239 },
    ],
  },
  {
    key: 'ei', name: 'Eieren', unit: 'st', pieceGrams: 60, category: 'zuivel-eieren',
    query: 'scharreleieren', aliases: ['eieren', 'eitjes'],
    packs: [
      { id: 'ei-6', name: 'Eieren 6 st', amount: 6, unit: 'st', cents: 219 },
      { id: 'ei-10', name: 'Eieren 10 st', amount: 10, unit: 'st', cents: 329 },
    ],
  },
  {
    key: 'boter', name: 'Roomboter', unit: 'g', category: 'zuivel-eieren',
    query: 'roomboter', aliases: ['boter'],
    packs: [
      { id: 'boter-250', name: 'Roomboter 250 g', amount: 250, unit: 'g', cents: 339 },
    ],
  },
  {
    key: 'margarine', name: 'Margarine', unit: 'g', category: 'zuivel-eieren',
    query: 'margarine',
    packs: [
      { id: 'margarine-250', name: 'Margarine 250 g', amount: 250, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'kookroom', name: 'Kookroom', unit: 'ml', category: 'zuivel-eieren',
    query: 'kookroom', aliases: ['room', 'slagroom'],
    packs: [
      { id: 'kookroom-250', name: 'Kookroom 250 ml', amount: 250, unit: 'ml', cents: 179 },
    ],
  },
  {
    key: 'yoghurt', name: 'Yoghurt halfvol', unit: 'ml', category: 'zuivel-eieren',
    query: 'yoghurt halfvol', aliases: ['yoghurt'],
    packs: [
      { id: 'yoghurt-1000', name: 'Yoghurt halfvol 1 L', amount: 1000, unit: 'ml', cents: 149 },
    ],
  },
  {
    key: 'griekse-yoghurt', name: 'Griekse yoghurt', unit: 'g', category: 'zuivel-eieren',
    query: 'griekse yoghurt', aliases: ['grieks'],
    packs: [
      { id: 'griekse-yoghurt-500', name: 'Griekse yoghurt 500 g', amount: 500, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'vla', name: 'Vla vanille', unit: 'ml', category: 'zuivel-eieren',
    query: 'vla vanille', aliases: ['vla'],
    packs: [
      { id: 'vla-1000', name: 'Vla vanille 1 L', amount: 1000, unit: 'ml', cents: 159 },
    ],
  },
  {
    key: 'creme-fraiche', name: 'Crème fraîche', unit: 'g', category: 'zuivel-eieren',
    query: 'creme fraiche', aliases: ['zure room'],
    packs: [
      { id: 'creme-fraiche-200', name: 'Crème fraîche 200 g', amount: 200, unit: 'g', cents: 169 },
    ],
  },
  {
    key: 'jong-belegen-plakken', name: 'Jong belegen kaas plakken', unit: 'g', category: 'kaas',
    query: 'jong belegen kaas plakken', aliases: ['kaas', 'kaasplakken', 'belegen plakken', 'belegen kaas'],
    packs: [
      { id: 'jong-belegen-plakken-200', name: 'Jong belegen kaas plakken 200 g', amount: 200, unit: 'g', cents: 349 },
    ],
  },
  {
    key: 'jong-belegen-blok', name: 'Jong belegen kaas blok', unit: 'g', category: 'kaas',
    query: 'jong belegen kaas blok', aliases: ['kaasblok', 'kaas'],
    packs: [
      { id: 'jong-belegen-blok-500', name: 'Jong belegen kaas blok 500 g', amount: 500, unit: 'g', cents: 799 },
    ],
  },
  {
    key: 'geraspte-kaas', name: 'Geraspte kaas', unit: 'g', category: 'kaas',
    query: 'geraspte kaas', aliases: ['rasp kaas'],
    packs: [
      { id: 'geraspte-kaas-150', name: 'Geraspte kaas 150 g', amount: 150, unit: 'g', cents: 239 },
      { id: 'geraspte-kaas-400', name: 'Geraspte kaas 400 g', amount: 400, unit: 'g', cents: 519 },
    ],
  },
  {
    key: 'mozzarella', name: 'Mozzarella', unit: 'g', category: 'kaas',
    query: 'mozzarella',
    packs: [
      { id: 'mozzarella-125', name: 'Mozzarella 125 g', amount: 125, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'parmezaan', name: 'Parmezaan', unit: 'g', category: 'kaas',
    query: 'parmezaan', aliases: ['parmigiano'],
    packs: [
      { id: 'parmezaan-100', name: 'Parmezaan 100 g', amount: 100, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'feta', name: 'Feta', unit: 'g', category: 'kaas',
    query: 'feta',
    packs: [
      { id: 'feta-200', name: 'Feta 200 g', amount: 200, unit: 'g', cents: 229 },
    ],
  },
  {
    key: 'halloumi', name: 'Halloumi', unit: 'g', category: 'kaas',
    query: 'halloumi',
    packs: [
      { id: 'halloumi-200', name: 'Halloumi 200 g', amount: 200, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'roomkaas', name: 'Roomkaas', unit: 'g', category: 'kaas',
    query: 'roomkaas', aliases: ['philadelphia'],
    packs: [
      { id: 'roomkaas-200', name: 'Roomkaas 200 g', amount: 200, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'brood', name: 'Brood', unit: 'st', pieceGrams: 800, category: 'brood',
    query: 'volkorenbrood', aliases: ['brood', 'volkorenbrood', 'wit brood'],
    packs: [
      { id: 'brood-volkoren', name: 'Volkorenbrood 1 st', amount: 1, unit: 'st', cents: 239 },
      { id: 'brood-wit', name: 'Wit brood 1 st', amount: 1, unit: 'st', cents: 219 },
    ],
  },
  {
    key: 'tortilla', name: 'Tortilla\'s', unit: 'st', pieceGrams: 40, category: 'brood',
    query: 'tortilla wraps', aliases: ['tortilla\'s', 'tortillas'],
    packs: [
      { id: 'tortilla-8', name: 'Tortilla wraps 8 st', amount: 8, unit: 'st', cents: 229 },
    ],
  },
  {
    key: 'wrap', name: 'Wraps groot', unit: 'st', pieceGrams: 60, category: 'brood',
    query: 'grote wraps', aliases: ['wraps'],
    packs: [
      { id: 'wrap-6', name: 'Grote wraps 6 st', amount: 6, unit: 'st', cents: 259 },
    ],
  },
  {
    key: 'pita', name: 'Pitabroodjes', unit: 'st', pieceGrams: 60, category: 'brood',
    query: 'pitabroodjes', aliases: ['pita'],
    packs: [
      { id: 'pita-6', name: 'Pitabroodjes 6 st', amount: 6, unit: 'st', cents: 189 },
    ],
  },
  {
    key: 'pizzabodem', name: 'Pizzabodems', unit: 'st', pieceGrams: 150, category: 'brood',
    query: 'pizzabodems', aliases: ['pizzabodem'],
    packs: [
      { id: 'pizzabodem-2', name: 'Pizzabodems 2 st', amount: 2, unit: 'st', cents: 249 },
    ],
  },
  {
    key: 'hamburgerbroodje', name: 'Hamburgerbroodjes', unit: 'st', pieceGrams: 60, category: 'brood',
    query: 'hamburgerbroodjes', aliases: ['broodjes'],
    packs: [
      { id: 'hamburgerbroodje-4', name: 'Hamburgerbroodjes 4 st', amount: 4, unit: 'st', cents: 199 },
    ],
  },
  {
    key: 'spaghetti', name: 'Spaghetti', unit: 'g', category: 'pasta-rijst',
    query: 'spaghetti', aliases: ['pasta'],
    packs: [
      { id: 'spaghetti-500', name: 'Spaghetti 500 g', amount: 500, unit: 'g', cents: 179 },
    ],
  },
  {
    key: 'penne', name: 'Penne', unit: 'g', category: 'pasta-rijst',
    query: 'penne', aliases: ['pasta', 'fusilli', 'macaroni'],
    packs: [
      { id: 'penne-500', name: 'Penne 500 g', amount: 500, unit: 'g', cents: 179 },
    ],
  },
  {
    key: 'lasagnebladen', name: 'Lasagnebladen', unit: 'g', category: 'pasta-rijst',
    query: 'lasagnebladen', aliases: ['lasagne'],
    packs: [
      { id: 'lasagnebladen-250', name: 'Lasagnebladen 250 g', amount: 250, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'rijst', name: 'Basmatirijst', unit: 'g', category: 'pasta-rijst',
    query: 'basmatirijst', aliases: ['rijst'],
    packs: [
      { id: 'rijst-500', name: 'Basmatirijst 500 g', amount: 500, unit: 'g', cents: 189 },
      { id: 'rijst-1000', name: 'Basmatirijst 1 kg', amount: 1000, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'risottorijst', name: 'Risottorijst', unit: 'g', category: 'pasta-rijst',
    query: 'risottorijst',
    packs: [
      { id: 'risottorijst-500', name: 'Risottorijst 500 g', amount: 500, unit: 'g', cents: 329 },
    ],
  },
  {
    key: 'couscous', name: 'Couscous', unit: 'g', category: 'pasta-rijst',
    query: 'couscous',
    packs: [
      { id: 'couscous-500', name: 'Couscous 500 g', amount: 500, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'mie', name: 'Bami mie', unit: 'g', category: 'pasta-rijst',
    query: 'bami mie', aliases: ['bami', 'noedels', 'mie'],
    packs: [
      { id: 'mie-250', name: 'Bami mie 250 g', amount: 250, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'tomatenblokjes', name: 'Tomatenblokjes', unit: 'g', category: 'conserven',
    query: 'tomatenblokjes', aliases: ['tomaten blik'],
    packs: [
      { id: 'tomatenblokjes-400', name: 'Tomatenblokjes 400 g', amount: 400, unit: 'g', cents: 99 },
      { id: 'tomatenblokjes-1200', name: 'Tomatenblokjes 3 x 400 g', amount: 1200, unit: 'g', cents: 269 },
    ],
  },
  {
    key: 'tomatenpuree', name: 'Tomatenpuree', unit: 'g', category: 'conserven',
    query: 'tomatenpuree',
    packs: [
      { id: 'tomatenpuree-70', name: 'Tomatenpuree 70 g', amount: 70, unit: 'g', cents: 99 },
    ],
  },
  {
    key: 'passata', name: 'Passata', unit: 'g', category: 'conserven',
    query: 'passata', aliases: ['tomatensaus', 'gezeefde tomaten', 'polpa'],
    packs: [
      { id: 'passata-700', name: 'Passata 700 g', amount: 700, unit: 'g', cents: 179 },
    ],
  },
  {
    key: 'kokosmelk', name: 'Kokosmelk', unit: 'ml', category: 'conserven',
    query: 'kokosmelk', aliases: ['kokos'],
    packs: [
      { id: 'kokosmelk-400', name: 'Kokosmelk 400 ml', amount: 400, unit: 'ml', cents: 169 },
    ],
  },
  {
    key: 'kikkererwten', name: 'Kikkererwten', unit: 'g', category: 'conserven',
    query: 'kikkererwten',
    packs: [
      { id: 'kikkererwten-400', name: 'Kikkererwten 400 g', amount: 400, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'kidneybonen', name: 'Kidneybonen', unit: 'g', category: 'conserven',
    query: 'kidneybonen', aliases: ['kidney bonen'],
    packs: [
      { id: 'kidneybonen-400', name: 'Kidneybonen 400 g', amount: 400, unit: 'g', cents: 109 },
    ],
  },
  {
    key: 'zwarte-bonen', name: 'Zwarte bonen', unit: 'g', category: 'conserven',
    query: 'zwarte bonen',
    packs: [
      { id: 'zwarte-bonen-400', name: 'Zwarte bonen 400 g', amount: 400, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'linzen', name: 'Linzen', unit: 'g', category: 'conserven',
    query: 'linzen', aliases: ['linzen blik'],
    packs: [
      { id: 'linzen-400', name: 'Linzen 400 g', amount: 400, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'mais', name: 'Maïs', unit: 'g', category: 'conserven',
    query: 'mais', aliases: ['maïs'],
    packs: [
      { id: 'mais-285', name: 'Maïs 285 g', amount: 285, unit: 'g', cents: 119 },
    ],
  },
  {
    key: 'spliterwten', name: 'Spliterwten', unit: 'g', category: 'conserven',
    query: 'spliterwten', aliases: ['erwten'],
    packs: [
      { id: 'spliterwten-500', name: 'Spliterwten 500 g', amount: 500, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'olijven', name: 'Zwarte olijven', unit: 'g', category: 'conserven',
    query: 'zwarte olijven', aliases: ['olijven'],
    packs: [
      { id: 'olijven-150', name: 'Zwarte olijven 150 g', amount: 150, unit: 'g', cents: 189 },
    ],
  },
  {
    key: 'zout', name: 'Zout', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'zeezout',
    packs: [
      { id: 'zout-250', name: 'Zeezout 250 g', amount: 250, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'peper', name: 'Peper', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'peper zwart gemalen',
    packs: [
      { id: 'peper-40', name: 'Peper zwart gemalen 40 g', amount: 40, unit: 'g', cents: 229 },
    ],
  },
  {
    key: 'bouillonblokjes', name: 'Bouillonblokjes', unit: 'st', pieceGrams: 10, category: 'kruiden-sauzen', staple: true,
    query: 'runderbouillonblokjes', aliases: ['bouillon', 'bouillonblokje'],
    packs: [
      { id: 'bouillonblokjes-12', name: 'Runderbouillonblokjes 12 st', amount: 12, unit: 'st', cents: 179 },
    ],
  },
  {
    key: 'gedroogde-kruiden', name: 'Italiaanse kruiden', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'italiaanse kruiden', aliases: ['oregano', 'gedroogde kruiden'],
    packs: [
      { id: 'gedroogde-kruiden-20', name: 'Italiaanse kruiden 20 g', amount: 20, unit: 'g', cents: 189 },
    ],
  },
  {
    key: 'paprikapoeder', name: 'Paprikapoeder', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'paprikapoeder',
    packs: [
      { id: 'paprikapoeder-40', name: 'Paprikapoeder 40 g', amount: 40, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'komijn', name: 'Komijn', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'komijn gemalen', aliases: ['djinten'],
    packs: [
      { id: 'komijn-35', name: 'Komijn gemalen 35 g', amount: 35, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'kerriepoeder', name: 'Kerriepoeder', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'kerriepoeder', aliases: ['kerrie'],
    packs: [
      { id: 'kerriepoeder-40', name: 'Kerriepoeder 40 g', amount: 40, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'chilipoeder', name: 'Chilipoeder', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'chilipoeder',
    packs: [
      { id: 'chilipoeder-35', name: 'Chilipoeder 35 g', amount: 35, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'nootmuskaat', name: 'Nootmuskaat', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'nootmuskaat gemalen',
    packs: [
      { id: 'nootmuskaat-35', name: 'Nootmuskaat gemalen 35 g', amount: 35, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'sojasaus', name: 'Sojasaus', unit: 'ml', category: 'kruiden-sauzen', staple: true,
    query: 'sojasaus', aliases: ['soja'],
    packs: [
      { id: 'sojasaus-250', name: 'Sojasaus 250 ml', amount: 250, unit: 'ml', cents: 229 },
    ],
  },
  {
    key: 'ketjap', name: 'Ketjap manis', unit: 'ml', category: 'kruiden-sauzen', staple: true,
    query: 'ketjap manis', aliases: ['ketjap'],
    packs: [
      { id: 'ketjap-250', name: 'Ketjap manis 250 ml', amount: 250, unit: 'ml', cents: 189 },
    ],
  },
  {
    key: 'sambal', name: 'Sambal oelek', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'sambal oelek', aliases: ['sambal'],
    packs: [
      { id: 'sambal-200', name: 'Sambal oelek 200 g', amount: 200, unit: 'g', cents: 189 },
    ],
  },
  {
    key: 'mosterd', name: 'Mosterd', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'mosterd',
    packs: [
      { id: 'mosterd-200', name: 'Mosterd 200 g', amount: 200, unit: 'g', cents: 139 },
    ],
  },
  {
    key: 'mayonaise', name: 'Mayonaise', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'mayonaise', aliases: ['mayo'],
    packs: [
      { id: 'mayonaise-450', name: 'Mayonaise 450 g', amount: 450, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'ketchup', name: 'Tomatenketchup', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'tomatenketchup', aliases: ['ketchup'],
    packs: [
      { id: 'ketchup-500', name: 'Tomatenketchup 500 g', amount: 500, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'taco-kruiden', name: 'Taco kruidenmix', unit: 'g', category: 'kruiden-sauzen', staple: true,
    query: 'taco kruidenmix', aliases: ['taco kruiden'],
    packs: [
      { id: 'taco-kruiden-35', name: 'Taco kruidenmix 35 g', amount: 35, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'salsa', name: 'Salsasaus', unit: 'g', category: 'kruiden-sauzen',
    query: 'salsasaus medium', aliases: ['salsa'],
    packs: [
      { id: 'salsa-230', name: 'Salsasaus medium 230 g', amount: 230, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'pesto', name: 'Pesto groen', unit: 'g', category: 'kruiden-sauzen',
    query: 'pesto groen', aliases: ['pesto'],
    packs: [
      { id: 'pesto-190', name: 'Pesto groen 190 g', amount: 190, unit: 'g', cents: 269 },
    ],
  },
  {
    key: 'currypasta', name: 'Groene currypasta', unit: 'g', category: 'kruiden-sauzen',
    query: 'groene currypasta', aliases: ['currypasta'],
    packs: [
      { id: 'currypasta-50', name: 'Groene currypasta 50 g', amount: 50, unit: 'g', cents: 169 },
    ],
  },
  {
    key: 'tikka-saus', name: 'Tikka masala saus', unit: 'g', category: 'kruiden-sauzen',
    query: 'tikka masala saus', aliases: ['tikka', 'tikka masala'],
    packs: [
      { id: 'tikka-saus-350', name: 'Tikka masala saus 350 g', amount: 350, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'hummus', name: 'Hummus', unit: 'g', category: 'kruiden-sauzen',
    query: 'hummus naturel', aliases: ['hummus'],
    packs: [
      { id: 'hummus-200', name: 'Hummus naturel 200 g', amount: 200, unit: 'g', cents: 199 },
    ],
  },
  {
    key: 'olijfolie', name: 'Olijfolie', unit: 'ml', category: 'olie-azijn', staple: true,
    query: 'olijfolie extra vierge', aliases: ['olie'],
    packs: [
      { id: 'olijfolie-500', name: 'Olijfolie extra vierge 500 ml', amount: 500, unit: 'ml', cents: 749 },
    ],
  },
  {
    key: 'zonnebloemolie', name: 'Zonnebloemolie', unit: 'ml', category: 'olie-azijn', staple: true,
    query: 'zonnebloemolie', aliases: ['bakolie', 'olie'],
    packs: [
      { id: 'zonnebloemolie-1000', name: 'Zonnebloemolie 1 L', amount: 1000, unit: 'ml', cents: 269 },
    ],
  },
  {
    key: 'azijn', name: 'Witte wijnazijn', unit: 'ml', category: 'olie-azijn', staple: true,
    query: 'witte wijnazijn', aliases: ['azijn'],
    packs: [
      { id: 'azijn-500', name: 'Witte wijnazijn 500 ml', amount: 500, unit: 'ml', cents: 199 },
    ],
  },
  {
    key: 'bloem', name: 'Tarwebloem', unit: 'g', category: 'bakken', staple: true,
    query: 'tarwebloem', aliases: ['bloem', 'meel'],
    packs: [
      { id: 'bloem-1000', name: 'Tarwebloem 1 kg', amount: 1000, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'suiker', name: 'Suiker', unit: 'g', category: 'bakken', staple: true,
    query: 'suiker', aliases: ['kristalsuiker'],
    packs: [
      { id: 'suiker-1000', name: 'Suiker 1 kg', amount: 1000, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'paneermeel', name: 'Paneermeel', unit: 'g', category: 'bakken',
    query: 'paneermeel',
    packs: [
      { id: 'paneermeel-200', name: 'Paneermeel 200 g', amount: 200, unit: 'g', cents: 129 },
    ],
  },
  {
    key: 'erwten', name: 'Doperwten diepvries', unit: 'g', category: 'diepvries',
    query: 'doperwten diepvries', aliases: ['doperwtjes', 'erwtjes'],
    packs: [
      { id: 'erwten-450', name: 'Doperwten 450 g', amount: 450, unit: 'g', cents: 179 },
    ],
  },
  {
    key: 'wokgroente', name: 'Roerbakgroenten', unit: 'g', category: 'diepvries',
    query: 'roerbakgroenten diepvries', aliases: ['wokgroente', 'roerbakgroente'],
    packs: [
      { id: 'wokgroente-600', name: 'Roerbakgroenten 600 g', amount: 600, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'friet', name: 'Friet', unit: 'g', category: 'diepvries',
    query: 'friet diepvries', aliases: ['patat', 'frietjes'],
    packs: [
      { id: 'friet-750', name: 'Friet 750 g', amount: 750, unit: 'g', cents: 229 },
    ],
  },
  {
    key: 'pils', name: 'Pils', unit: 'ml', category: 'drinken',
    query: 'pils', aliases: ['bier', 'krat bier', 'pilsje', 'biertje'],
    packs: [
      { id: 'pils-krat-24', name: 'Krat pils 24 x 30 cl', amount: 7200, unit: 'ml', cents: 1899 },
      { id: 'pils-6', name: 'Pils 6 x 33 cl', amount: 1980, unit: 'ml', cents: 729 },
    ],
  },
  {
    key: 'frisdrank', name: 'Frisdrank', unit: 'ml', category: 'drinken',
    query: 'cola', aliases: ['cola', 'fris', 'limonade'],
    packs: [
      { id: 'frisdrank-1500', name: 'Cola 1,5 L', amount: 1500, unit: 'ml', cents: 199 },
      { id: 'frisdrank-1980', name: 'Cola 6 x 33 cl', amount: 1980, unit: 'ml', cents: 549 },
    ],
  },
  {
    key: 'sap', name: 'Sap', unit: 'ml', category: 'drinken',
    query: 'appelsap', aliases: ['appelsap', 'sinaasappelsap', 'jus d\'orange'],
    packs: [
      { id: 'sap-1000', name: 'Appelsap 1 L', amount: 1000, unit: 'ml', cents: 149 },
      { id: 'sap-1500', name: 'Sinaasappelsap 1,5 L', amount: 1500, unit: 'ml', cents: 249 },
    ],
  },
  {
    key: 'koffie', name: 'Koffie', unit: 'g', category: 'drinken',
    query: 'koffiebonen', aliases: ['koffiebonen', 'koffie'],
    packs: [
      { id: 'koffie-500', name: 'Koffiebonen 500 g', amount: 500, unit: 'g', cents: 899 },
    ],
  },
  {
    key: 'thee', name: 'Thee', unit: 'st', pieceGrams: 2, category: 'drinken',
    query: 'thee builtjes', aliases: ['thee'],
    packs: [
      { id: 'thee-20', name: 'Thee 20 builtjes', amount: 20, unit: 'st', cents: 179 },
    ],
  },
  {
    key: 'pindakaas', name: 'Pindakaas', unit: 'g', category: 'ontbijt',
    query: 'pindakaas',
    packs: [
      { id: 'pindakaas-350', name: 'Pindakaas 350 g', amount: 350, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'hagelslag', name: 'Hagelslag', unit: 'g', category: 'ontbijt',
    query: 'hagelslag melk', aliases: ['hagelslag'],
    packs: [
      { id: 'hagelslag-400', name: 'Hagelslag melk 400 g', amount: 400, unit: 'g', cents: 279 },
    ],
  },
  {
    key: 'havermout', name: 'Havermout', unit: 'g', category: 'ontbijt',
    query: 'havermout',
    packs: [
      { id: 'havermout-500', name: 'Havermout 500 g', amount: 500, unit: 'g', cents: 149 },
    ],
  },
  {
    key: 'jam', name: 'Aardbeienjam', unit: 'g', category: 'ontbijt',
    query: 'aardbeienjam', aliases: ['jam'],
    packs: [
      { id: 'jam-450', name: 'Aardbeienjam 450 g', amount: 450, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'tortillachips', name: 'Tortillachips', unit: 'g', category: 'snacks',
    query: 'tortillachips naturel', aliases: ['nacho\'s', 'nachos'],
    packs: [
      { id: 'tortillachips-185', name: 'Tortillachips naturel 185 g', amount: 185, unit: 'g', cents: 219 },
    ],
  },
  {
    key: 'chips', name: 'Chips naturel', unit: 'g', category: 'snacks',
    query: 'chips naturel', aliases: ['chips'],
    packs: [
      { id: 'chips-225', name: 'Chips naturel 225 g', amount: 225, unit: 'g', cents: 249 },
    ],
  },
  {
    key: 'wc-papier', name: 'Wc-papier', unit: 'st', category: 'huishouden',
    query: 'wc-papier', aliases: ['toiletpapier'],
    packs: [
      { id: 'wc-papier-12', name: 'Wc-papier 12 rollen', amount: 12, unit: 'st', cents: 549 },
    ],
  },
  {
    key: 'afwasmiddel', name: 'Afwasmiddel', unit: 'ml', category: 'huishouden',
    query: 'afwasmiddel', aliases: ['spulmiddel'],
    packs: [
      { id: 'afwasmiddel-500', name: 'Afwasmiddel 500 ml', amount: 500, unit: 'ml', cents: 189 },
    ],
  },
  {
    key: 'keukenpapier', name: 'Keukenpapier', unit: 'st', category: 'huishouden',
    query: 'keukenpapier', aliases: ['keukenrol'],
    packs: [
      { id: 'keukenpapier-4', name: 'Keukenpapier 4 rollen', amount: 4, unit: 'st', cents: 349 },
    ],
  },
];
