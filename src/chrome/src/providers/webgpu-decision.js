import { WebGPUProvider, WEBGPU_COMPASS_VLD_MODEL_IDS } from './webgpu.js';
import { splitD1State } from './d1-runtime.js';
import { readyChatDecisionModel } from '../agent/decision-availability.js';

// Decisions on the in-browser chat model (Compass VLD and its trained probe):
// the newest build downloaded, v6 2B or else Tiny v5. Runs in the offscreen
// WebGPU worker; nothing leaves the browser.
export async function evaluateWebgpuDecision({ state, images, questions, config, signal } = {}) {
  if (!WEBGPU_COMPASS_VLD_MODEL_IDS.includes(config?.model)) throw new Error('Only Compass VLD answers in-browser decisions.');
  if (signal?.aborted) throw signal.reason;
  // Callers put screenshots in the state as image_url blocks (completion
  // checks, the Settings vision probe); the model takes them as images, as
  // D1 does, never as base64 text in the prompt.
  const input = splitD1State(state, images);
  const model = await readyChatDecisionModel() || config.model;
  const provider = new WebGPUProvider({ model });
  const result = await provider.decide({ state: input.state, images: input.images, questions, signal });
  if (signal?.aborted) throw signal.reason;
  return { model: result.model, provider: 'webgpu_chat', answers: result.answers, usage: result.usage };
}
