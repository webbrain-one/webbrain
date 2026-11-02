/**
 * The files of WebBrain Compass VLD v6 2B's in-browser build
 * (webbrain-one/webbrain-compass-vld-v6-2b-onnx), read at a pinned commit with
 * each file's size and SHA-256 from the bundle's manifest.json. Kept apart
 * from the runtime so the shared download code (compass-vld-runtime.js) and
 * the v6 runtime (compass-vld-v6-runtime.js) both read it without importing
 * each other.
 *
 * Two graphs: vision_encoder (fp16) and decoder (q8f16 recommended by the
 * bundle's config, q4f16 the lighter build). The decoder embeds the tokens
 * and writes the image features into the image-token rows itself.
 */

export const COMPASS_VLD_V6_MODEL_ID = 'webbrain-one/webbrain-compass-vld-v6-2b-onnx';
// A later commit (a model card edit, a new graph) cannot change what an
// install downloads; a new graph needs a new revision here and new pins below.
export const COMPASS_VLD_V6_REVISION = '4e8a6dec76514be2d779b0c7e0b63fd29d9bde1c';
export const COMPASS_VLD_V6_DTYPE = Object.freeze({
  vision_encoder: 'fp16',
  decoder: 'q8f16',
});
export const COMPASS_VLD_V6_GRAPHS = Object.freeze(['vision_encoder', 'decoder']);
export const COMPASS_VLD_V6_METADATA_FILES = Object.freeze([
  'config.json', 'generation_config.json', 'processor_config.json',
  'tokenizer_config.json', 'chat_template.jinja', 'tokenizer.json',
]);
export const COMPASS_VLD_V6_FILE_PINS = Object.freeze({
  'config.json': [3444, '4fb1a1fadbb8e6bd89ad413c2e6a74b27d8efae98b6cc019071598a942f308b4'],
  'generation_config.json': [323, '30b1115bcdc4e5671567a5b1255a2f3d2f5a912a79292051c6f1e9db81b5e8c4'],
  'processor_config.json': [1535, 'd3d5c3f9dc3d3f25c3177ba8bb05938b53c51799244af1ca6406cde78924b84e'],
  'tokenizer.json': [17908258, 'a39eed58008cbcbc09e5b629b81338a654269c64cd13348aaa6090f4db75c7e7'],
  'tokenizer_config.json': [1759, '0117c195c81c937dbef42e384fa2850aebd066d14b7ea8345cabfbb5c05e584c'],
  'chat_template.jinja': [12129, 'f45005c50cd2a97329722bf3a2dee9f16c04cdf825a589b280fb7e99e6827818'],
  'onnx/vision_encoder_fp16.onnx': [104940, 'd6f3ed9a9211feb09d146fb8d550517a7b779940d081eb1604127bfe23ca2e6a'],
  'onnx/vision_encoder_fp16.onnx_data': [379021312, '46adefaace14f48dba264742360ea9a056cf2e581ec26ab2756095dcf1a31946'],
  'onnx/decoder_q8f16.onnx': [268133, 'c098f7f0296ec2d5f401878099720cd18467cf934b2673a9edc4f829d2d65b01'],
  'onnx/decoder_q8f16.onnx_data': [1956758528, 'c4a74412262cfa5d61ff89d17be96529c214d7bb341613b0796fad73d4bddcb4'],
  'onnx/decoder_q4f16.onnx': [273254, '128353f02f9e7f8b72f3784ac829b4685a251b4479d81cef26c31fc5519c1936'],
  'onnx/decoder_q4f16.onnx_data': [1314248704, 'da99bbde6e9f8395be81c8488d92606d6565febc116d54a29345733051dbba1f'],
});
