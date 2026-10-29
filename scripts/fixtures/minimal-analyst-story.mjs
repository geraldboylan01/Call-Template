// Smoke-test scaffolding, not an analyst or an authored household analysis.
import { getStoryRequirements } from '../../js/planning/plan_pack/story_checker.js';

export function minimalAnalystStory(compiled, routeId = 'current') {
  const r = getStoryRequirements(compiled, routeId);
  const parts = () => ({ does: 'This view keeps your recorded facts visible.', why: 'The illustration follows the compiled inputs.',
    gives: 'The results come from code.', costs: 'Resources assigned here cannot also meet other goals.', check: 'Review changed facts and recorded limitations.' });
  const sections = ['current_position', 'ledger', 'protecting', 'inefficiencies', 'goals', 'cash_flow_after', 'net_worth_after', 'risks', 'check_next']
    .map(id => ({ id, title: 'Your recorded position', parts: parts() }));
  for (const section of sections) {
    section.parts.gives += ' ' + r.required.filter(row => row.section === section.id).map(row => '{' + row.key + '}').join(' ');
    const limits = r.limitations.filter(row => row.section === section.id || section.id === 'check_next');
    section.limitationIds = limits.map(row => row.id);
    section.parts.check += ' ' + limits.map(row => '{' + row.key + '}').join(' ');
  }
  sections[4].goals = r.goalIds.map(id => ({ goalId: id, title: '{goals.' + id + '.title}', parts: { ...parts(),
    gives: r.required.filter(row => row.section === 'goals' && row.key.startsWith('goals.' + id + '.')).map(row => '{' + row.key + '}').join(' ') } }));
  sections[3].issues = r.issues.map(row => row.id);
  sections[5].freedCash = r.freed.map(row => row.id);
  sections[4].majorMoves = r.majorMoves.map(row => row.id);
  sections[4].parts.gives += ' ' + r.majorMoves.flatMap(row => row.factKeys).map(key => '{' + key + '}').join(' ');
  sections[7].risks = routeId === 'current' ? [] : [{ changeIds: r.mainChangeIds }];
  sections[7].parts.check += ' The what-if tool is not built. Further stress results remain unavailable.';
  return { routeId, headline: 'Your recorded position', summary: 'This view follows your compiled route.', sections,
    whatifs: r.whatifs.filter(row => row.status === 'compiled').map(row => ({ id: row.id })) };
}
