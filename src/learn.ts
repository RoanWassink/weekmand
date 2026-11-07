import { createHash } from 'node:crypto';
import type { Feedback, Suggestion } from './db.ts';
import { previousWeek, weekdays } from './time.ts';
import type { AvoidRule } from './types.ts';

/** Tags die iets zeggen over smaak; 'snel' of 'budget' schrappen zegt weinig. */
const meaningful = ['vis', 'kip', 'rund', 'varken', 'gehakt', 'vegetarisch', 'vegan', 'hollands', 'italiaans', 'mexicaans', 'aziatisch', 'indiaas', 'mediterraan', 'midden-oosten', 'amerikaans', 'soep', 'salade'];

export const ruleId = (rule: AvoidRule) => createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 12);

function consecutive(weeks: Set<string>) {
  return [...weeks].some(w => weeks.has(previousWeek(w)));
}

/**
 * Herken patronen in afwijzingen: hetzelfde twee weken achter elkaar afgekeurd.
 * Geeft nieuwe voorstellen terug; bestaande (ook afgewezen) voorstellen komen niet opnieuw.
 */
export function detectHabits(feedback: Feedback[], names: { recipe: (id: string) => string | undefined; ingredient: (key: string) => string | undefined }, known: Set<string>): Suggestion[] {
  const groups = new Map<string, { rule: AvoidRule; weeks: Set<string>; text: string }>();
  const add = (rule: AvoidRule, week: string, text: string) => {
    const id = ruleId(rule);
    const group = groups.get(id) ?? { rule, weeks: new Set<string>(), text };
    group.weeks.add(week);
    groups.set(id, group);
  };
  for (const f of feedback) {
    if (f.kind === 'meal-rejected' && f.recipeId) {
      const name = names.recipe(f.recipeId) ?? f.recipeId;
      add({ kind: 'recipe', recipeId: f.recipeId }, f.week, `Je hebt "${name}" twee weken achter elkaar geschrapt. Zal ik het niet meer voorstellen?`);
      if (f.weekday !== undefined) for (const tag of (f.tags ?? []).filter(t => meaningful.includes(t))) {
        add({ kind: 'tag-weekday', tag, weekday: f.weekday }, f.week,
          `Je schrapt vaak ${tag === 'vegetarisch' ? 'vegetarisch' : tag} op ${weekdays[f.weekday]}. Zal ik dat voortaan vermijden?`);
      }
    }
    if (f.kind === 'item-removed' && f.key) {
      add({ kind: 'ingredient-auto', key: f.key }, f.week,
        `Je haalt ${names.ingredient(f.key)?.toLowerCase() ?? f.key} vaak weg. Zal ik het niet meer automatisch toevoegen?`);
    }
  }
  const result: Suggestion[] = [];
  for (const [id, group] of groups) {
    if (known.has(id) || !consecutive(group.weeks)) continue;
    result.push({ id, text: group.text, rule: group.rule, status: 'open', createdAt: new Date().toISOString() });
  }
  // Een weekdagpatroon is specifieker en nuttiger dan losse recepten: toon die eerst.
  return result.sort((a, b) => Number((b.rule as AvoidRule).kind === 'tag-weekday') - Number((a.rule as AvoidRule).kind === 'tag-weekday'));
}
