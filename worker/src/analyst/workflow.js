import { WorkflowEntrypoint } from 'cloudflare:workers';
import { runAnalyst } from './runner.js';
import { analystStorage } from './storage.js';
import { analystBudget } from './budget.js';
import { callAnalystModel } from '../consumer/ai_provider.js';
import { ANALYST_INSTRUCTIONS } from './instructions.generated.js';

export class AnalystWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    // These engines log on each compile. Workers do not need those diagnostics;
    // results and refusals are already saved in the encrypted case's run log.
    console.info = () => {};
    return runAnalyst({ ...event.payload, step, env: this.env,
      storage: analystStorage(this.env), budget: analystBudget(this.env),
      model: body => callAnalystModel(this.env, body), instructions: ANALYST_INSTRUCTIONS,
      metric: value => console.debug(JSON.stringify(value)) });
  }
}
