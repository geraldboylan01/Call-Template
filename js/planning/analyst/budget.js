import { RUN_LIMITS } from './contracts.js';

/** Call-local guard shared by every nested compiler invocation. */
export function compilerBudget(caseFile) {
  const usage = { compilerRuns: 0 };
  return { usage, beforeCompile() {
    const fail = (path, message) => { throw Object.assign(new Error(message), { code: 'budget_exceeded', path }); };
    if (caseFile.budget.compilerRuns >= RUN_LIMITS.compilerRuns) fail('/budget/compilerRuns', 'The plan has used its compiler-run guard.');
    if (usage.compilerRuns >= RUN_LIMITS.compilerRunsPerCall) fail('/budget/compilerRunsPerCall', 'This call has used its compiler-run guard.');
    usage.compilerRuns++;
    caseFile.budget.compilerRuns++;
  } };
}
