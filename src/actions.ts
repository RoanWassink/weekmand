import type { Notice, Weekmand } from './app.ts';
import { formatPlan } from './assistant.ts';
import { Problem } from './errors.ts';
import type { Question } from './planner.ts';
import { clock, dayName, localDate, longDate } from './time.ts';
import { planSummary } from './tools.ts';

/**
 * Knoppen in meldingen werken overal hetzelfde (Telegram, webapp, Home Assistant):
 *   apply:<reviewId>   mand bijwerken          skip:<reviewId>   niet nu
 *   q:<key>:yes|no     voorraadvraag           sugg:<id>:yes|no  geleerd voorstel
 *   menu:approve       weekmenu goedkeuren
 */
type Pending = { questions: Question[]; asked: string | null };
/** Redenen voor duimpje omlaag; ook gebruikt in de webapp. */
export const reasons: Record<string, string> = { smaak: 'Niet lekker', werk: 'Te veel werk', kids: 'Kinderen lustten het niet', porties: 'Porties klopten niet', duur: 'Te duur', anders: 'Iets anders' };

/** Vraag na het eten: 'Hoe was de … gisteren?' met duimpjes. */
export function ratingNotice(app: Weekmand, date: string): Notice | null {
  const meal = app.store.meal(date);
  if (!meal || !meal.ordered || app.store.rating(date)) return null;
  const name = app.catalog.recipe(meal.recipeId)?.name ?? meal.recipeId;
  return { text: `Hoe was de ${name.toLowerCase()} van ${dayName(date)}?`, buttons: [{ label: '👍 Lekker', data: `rate:${date}:up` }, { label: '👎 Niet goed', data: `rate:${date}:down` }], key: 'rate-' + date };
}

const applyButtons = (id: string) => [{ label: 'Naar Picnic sturen', data: 'apply:' + id }, { label: 'Niet nu', data: 'skip:' + id }];
const questionButtons = (q: Question) => [{ label: 'Ja', data: `q:${q.key}:yes` }, { label: 'Nee, op', data: `q:${q.key}:no` }];

/** Volgende stap: nog een voorraadvraag, of het overzicht met de knop om de mand bij te werken. */
async function nextStep(app: Weekmand, prefix = ''): Promise<Notice> {
  const pending = app.store.get<Pending>('pendingQuestions', { questions: [], asked: null });
  const next = pending.questions.shift();
  if (next) {
    app.store.set('pendingQuestions', { questions: pending.questions, asked: next.key });
    return { text: (prefix ? prefix + '\n\n' : '') + next.text + ' (ja/nee)', buttons: questionButtons(next) };
  }
  app.store.set('pendingQuestions', { questions: [], asked: null });
  const plan = await app.currentPlan();
  const summary = planSummary(plan);
  const changes = plan.lines.some(l => l.add || l.remove);
  return { text: (prefix ? prefix + '\n\n' : '') + formatPlan(summary), ...(changes ? { buttons: applyButtons(plan.id) } : {}) };
}

/** Is er een open ja/nee-vraag? Dan kan een los "ja" of "nee" in de chat die beantwoorden. */
export function openQuestion(app: Weekmand) { return app.store.get<Pending>('pendingQuestions', { questions: [], asked: null }).asked; }

export async function handleAction(app: Weekmand, data: string): Promise<Notice> {
  const [kind, id, answer] = String(data).split(':');
  try {
    if (kind === 'apply') {
      const result = await app.applyPlan(id);
      return { text: result.already ? 'De mand was al bijgewerkt.' : result.summary + '\nRond de bestelling af in de Picnic-app.' };
    }
    if (kind === 'skip') return { text: 'Prima, ik laat de mand zoals hij is. Zeg "mand" als je later wilt kijken.' };
    if (kind === 'q') {
      const yes = answer === 'yes';
      const item = app.updatePantry([{ name: id, status: yes ? 'genoeg' : 'op' }])[0];
      return nextStep(app, yes ? `Top, ${item.name.toLowerCase()} hoef ik niet te kopen.` : `Genoteerd: ${item.name.toLowerCase()} is op.`);
    }
    if (kind === 'sugg') return { text: app.respondSuggestion(id, answer === 'yes') };
    if (kind === 'rate') {
      if (answer === 'up') return { text: app.rateMeal(id, 'up') };
      if (answer === 'down') return { text: 'Jammer! Wat was er mis?', buttons: Object.entries(reasons).map(([code, label]) => ({ label, data: `rate:${id}:why:${code}` })) };
      if (answer === 'why') return { text: app.rateMeal(id, 'down', reasons[String(data).split(':')[3]] ?? '') };
    }
    if (kind === 'menu' && id === 'approve') {
      const n = await app.approveMenu();
      return nextStep(app, n ? `${n} maaltijden goedgekeurd.` : 'Het menu was al goedgekeurd.');
    }
    return { text: 'Deze knop ken ik niet (meer).' };
  } catch (error) {
    if (error instanceof Problem) return { text: error.message };
    console.error('Actie', kind, error);
    return { text: 'Dat lukte niet. Probeer het opnieuw in Weekmand.' };
  }
}

/**
 * Het proactieve bericht vóór de wijzigdeadline: menu aanvullen, vaste producten klaarzetten,
 * onzekere voorraad navragen en daarna de mand laten goedkeuren.
 */
export async function cutoffNotice(app: Weekmand): Promise<Notice | null> {
  const delivery = await app.delivery();
  const slot = delivery.next;
  if (!slot) return null;
  const menu = await app.menu();
  const empty = menu.days.filter(d => d.inOrder && !d.meal).length;
  const filled = empty ? await app.proposeMenu() : menu;
  const meals = filled.days.filter(d => d.inOrder && d.meal);
  const plan = await app.plan();
  const regulars = app.regulars().filter(r => r.enabled).length;
  const today = localDate(app.now());
  const cutDay = localDate(Date.parse(slot.cutOff));
  const when = cutDay === today ? 'vanavond' : `op ${dayName(cutDay)}`;
  const intro = [
    `Hoi! Je ${app.shop.label}-bestelling voor ${longDate(slot.windowStart)} wordt ${when} om ${clock(slot.cutOff)} definitief.`,
    `Ik heb ${regulars ? `${regulars} vaste producten en ` : ''}${meals.length} maaltijden klaargezet:`,
    ...meals.map(d => `• ${d.day}: ${d.meal!.name}${d.meal!.servings !== undefined ? ` (${d.meal!.servings} p.)` : ''}`),
  ].join('\n');
  app.store.set('pendingQuestions', { questions: plan.questions, asked: null });
  const step = await nextStep(app);
  return { text: intro + '\n\n' + step.text, buttons: step.buttons, key: 'cutoff-' + slot.id };
}
