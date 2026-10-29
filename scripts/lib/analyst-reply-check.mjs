import assert from 'node:assert/strict';
import { toolReply } from '../../js/planning/analyst/replies.js';

export function checkReply(name, result, input = {}, household = '') {
  const reply = toolReply(name, result, input);
  const bytes = Buffer.byteLength(JSON.stringify(reply));
  assert.ok(bytes < 60_000, `${household} ${name}: reply is ${bytes} bytes (limit 60000)`);
  if (['price_route', 'goal_ways', 'suggest_routes', 'balancing_moves'].includes(name)) {
    assert.doesNotMatch(JSON.stringify(reply), /"(?:compilation|planPack|normalizedPlanPack)":/, name + ': internal compilation in reply');
  }
  return reply;
}
