/**
 * The live lane's provider session policy.
 *
 * TWO SETTINGS ARE THE WHOLE POINT OF THIS FILE.
 *
 *   create_response: true   the provider replies as soon as the client stops
 *                           speaking. Nothing on the server gets to decide
 *                           whether the model may talk.
 *   tool_choice: 'auto'     the model has real tools while it speaks, instead
 *                           of reading a server-composed line with tools off.
 *
 * The v2 policy sets both the other way (`realtime_provider.js:339`, and
 * `tool_choice: 'none'` on every conversational response at
 * `realtime_session.js:1530`), which is why that lane cannot reply quickly and
 * cannot decide anything.
 *
 * `instructions` is the byte-stable catalogue prompt and is set ONCE, at call
 * creation. It is never rewritten mid-call: the v2 lane re-sends a 12 KB brief
 * inside `instructions` every turn, which throws away the cached prefix that is
 * the single biggest cost and latency lever on Realtime.
 */

import { buildLiveCataloguePrompt } from './catalogue_prompt.js';
import { LIVE_TOOL_DEFINITIONS } from './live_tools.js';

export function buildLiveSessionConfig(config) {
  return {
    type: 'realtime',
    model: config.realtimeModel,
    instructions: buildLiveCataloguePrompt(),
    reasoning: { effort: 'low' },
    output_modalities: ['audio'],
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        noise_reduction: { type: 'far_field' },
        transcription: { model: config.realtimeTranscriptionModel, language: 'en' },
        turn_detection: {
          type: 'semantic_vad',
          // Between the v2 lane's two settings. 'low' was chosen there to stop
          // an eager boundary turning one sentence into several server-composed
          // questions — a problem this lane does not have, because the model
          // owns its own pacing and can simply keep listening. 'high' clips
          // people who pause mid-figure.
          eagerness: 'medium',
          // THE INVERSION. The provider, not the server, decides when to reply.
          create_response: true,
          interrupt_response: true
        }
      },
      output: {
        format: { type: 'audio/pcm', rate: 24_000 },
        speed: 1,
        voice: 'marin'
      }
    },
    tools: LIVE_TOOL_DEFINITIONS,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    max_output_tokens: 1_200,
    truncation: {
      type: 'retention_ratio',
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8_000 }
    }
  };
}
