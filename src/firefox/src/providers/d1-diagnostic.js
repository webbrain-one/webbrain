import { DECISION_SETTINGS_KEYS, resolveDecisionConfig, resolveDecisionMode } from '../agent/decision-config.js';
import { validateSystemOneAnswers } from '../agent/systemone-judge.js';
import { D1_CONSENT_KEY, D1_CONSENT_VERSION } from './d1-config.js';

export async function evaluateD1LocalFixture({ fixture, sender, api, strictSecretMode, agent, client }) {
  const settingsUrl = api.runtime.getURL('src/ui/settings.html');
  if (sender?.id !== api.runtime.id || String(sender.url || '').split(/[?#]/)[0] !== settingsUrl) throw new Error('Local D1 fixture tests are available only from the extension Settings page.');
  if (strictSecretMode) throw new Error('Decision requests are disabled in Strict Secret Mode.');
  const stored = await api.storage.local.get(DECISION_SETTINGS_KEYS);
  if (stored.decisionProvider !== 'webgpu_d1' || resolveDecisionMode(stored) !== 'on' || stored[D1_CONSENT_KEY] !== D1_CONSENT_VERSION) throw new Error('Select, enable and explicitly consent to the local D1 provider before testing a fixture.');
  const config = resolveDecisionConfig(stored);
  if (config.provider !== 'webgpu_d1' || !config.enabled) throw new Error('Select, enable and explicitly consent to the local D1 provider before testing a fixture.');
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture) || !Object.hasOwn(fixture, 'state') || !fixture.questions || (fixture.images != null && !Array.isArray(fixture.images))) throw new Error('Invalid local D1 fixture.');
  if (fixture.images?.length && !config.supportsVision) throw new Error('Enable local D1 vision before testing an image fixture.');
  const result = await agent.evaluateSystemOne(null, client, { state: fixture.state, images: fixture.images, questions: fixture.questions, config });
  validateSystemOneAnswers(result.answers, fixture.questions);
  if (result.model !== config.model || result.provider !== 'webgpu_d1' || !Number.isInteger(result.usage?.input_tokens) || result.usage.input_tokens < 0 || result.usage?.output_tokens !== 0) throw new Error('Invalid local D1 fixture response.');
  return result;
}
