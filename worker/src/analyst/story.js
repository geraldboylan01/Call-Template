import { caseRefusal } from '../../../js/planning/analyst/case_file.js';
import { compileCaseStories } from '../../../js/planning/analyst/compilation.js';
import { checkStory } from '../../../js/planning/plan_pack/story_checker.js';
import { sha256Json } from '../../../js/planning/utils.js';
import { buildSessionFromPlan } from '../../../js/plan_story_compiled.js';

// Same opening contract as analyst:open, including draft/compilation binding.
export async function acceptedSession(caseFile) {
  const refusal = await caseRefusal(caseFile);
  if (refusal) throw new Error('This run uses different inputs or tool versions. Create a new run.');
  const stories = caseFile.storyDrafts;
  if (!Object.keys(stories).length) throw new Error('No accepted draft.');
  const { compilation, signature } = await compileCaseStories(caseFile, stories);
  for (const [routeId, story] of Object.entries(stories)) {
    const checked = caseFile.storyChecks?.[routeId];
    if (!checked?.report?.ok || checked.compilationSignature !== signature || checked.storyHash !== await sha256Json(story)
      || !checkStory(compilation, story).ok) throw new Error('This exact draft and compilation must pass the checker.');
  }
  return buildSessionFromPlan(compilation, stories, { clientName: caseFile.pinned.profile?.displayName ?? compilation.clientName });
}
