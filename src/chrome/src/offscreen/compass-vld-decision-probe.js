// Decision probe for WebBrain Compass VLD Tiny v5 (webbrain-one/webbrain-compass-vld-tiny-v5-onnx),
// trained by scripts/models/bonsai/train_decision_probe.py on d1's balanced-V3 train split
// (synthetic, AI-labelled screens), regularization (l2 = 0.03) chosen on its validation split.
// Its features came from the PyTorch model running this worker's verify protocol; the
// extension's WebGPU worker then reproduced the test result (below).
// The backbone is frozen: each option of a question is scored from its verify
// continuation as  margin * COMPASS_VLD_DECISION_PROBE.margin + hidden . weights, where margin
// is the Yes-minus-No logit and hidden is the decoder's last-position state
// (decision_hidden). Standardization is folded into the weights; constant
// offsets cancel in the softmax over a question's options. The model itself
// was fine-tuned on d1's train split, so the weights on the hidden state are
// small and the score is close to a scaled Yes margin.
//
// Validation: 123/126 categorical, 24/24 completions found, 0/48 false
// completions. Test (PyTorch features): 121/126 categorical, 24/24 found, 0/48 false
// completions; the extension's worker on WebGPU with the Q8 graphs: 120/126, 24/24, 0/48.
export const COMPASS_VLD_DECISION_PROBE = Object.freeze({
  model: 'webbrain-one/webbrain-compass-vld-tiny-v5-onnx',
  hiddenSize: 1024,
  margin: 1.4427485794947605,
  weightsBase64: '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',
});

// Decision probe for WebBrain Compass VLD v6 2B (webbrain-one/webbrain-compass-vld-v6-2b-onnx),
// shipped with the ONNX bundle (runtime/lfm3-decision-probe-cs.js, validation/probe-cs.json):
// trained by train_decision_probe_cs.py on d1's balanced-V3 train split with a
// cost-sensitive fit (false-completion weight lambda = 1.0, l2 = 0.001). The fit
// kept no weight on the hidden state and no per-type bias, so a question's
// options are scored by their Yes-minus-No margins alone (margin weight 1.0).
//
// Validation: 126/126 categorical, 24/24 completions found, 0/48 false
// completions. Test: 122/126 categorical, 24/24 found, 0/48 false completions,
// 24/24 unknown.
export const COMPASS_VLD_V6_DECISION_PROBE = Object.freeze({
  model: 'webbrain-one/webbrain-compass-vld-v6-2b-onnx',
  hiddenSize: 2048,
  margin: 1.0,
  // All 2048 hidden-state weights are zero.
  weightsBase64: '',
});

const PROBES = new Map([COMPASS_VLD_DECISION_PROBE, COMPASS_VLD_V6_DECISION_PROBE].map(probe => [probe.model, probe]));

/** The decision probe trained for a Compass VLD build, or null. */
export function compassVldDecisionProbe(modelId) {
  return PROBES.get(String(modelId || '').trim()) || null;
}

const decoded = new Map();
function probeWeights(probe) {
  if (!decoded.has(probe.model)) {
    let weights = new Float32Array(probe.hiddenSize);
    if (probe.weightsBase64) {
      const binary = atob(probe.weightsBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      weights = new Float32Array(bytes.buffer);
    }
    decoded.set(probe.model, weights);
  }
  return decoded.get(probe.model);
}

/** Per-option scores for one question; a softmax over them is the answer. */
export function compassVldProbeScores(margins, hidden, modelId = COMPASS_VLD_DECISION_PROBE.model) {
  const probe = compassVldDecisionProbe(modelId);
  if (!probe) throw new Error(`No decision probe is trained for ${modelId}.`);
  const w = probeWeights(probe);
  return margins.map((margin, index) => {
    const vector = hidden[index];
    if (!vector || vector.length !== w.length) throw new Error('The decision probe needs the decoder hidden state.');
    let dot = 0;
    for (let i = 0; i < w.length; i++) dot += w[i] * vector[i];
    return margin * probe.margin + dot;
  });
}
