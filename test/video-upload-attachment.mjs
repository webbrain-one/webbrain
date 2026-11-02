import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {isVideoAttachment, videoMimeType} from '../src/chrome/src/ui/attachment-file.js';
import {Agent as ChromeAgent} from '../src/chrome/src/agent/agent.js';
import {Agent as FirefoxAgent} from '../src/firefox/src/agent/agent.js';
import {getMessageRecipientGuardPolicy as chromePolicy, isPublicComposerRoute as chromePublicComposer} from '../src/chrome/src/agent/adapters.js';
import {getMessageRecipientGuardPolicy as firefoxPolicy, isPublicComposerRoute as firefoxPublicComposer} from '../src/firefox/src/agent/adapters.js';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(4), Buffer.from('mp42isom')]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  '), Buffer.alloc(4), Buffer.from('qt  ')]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), Buffer.from('webm')]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
const garbage = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);

const payload = (bytes, name, mimeType) => ({base64: bytes.toString('base64'), filename: name, mimeType});

test('videoMimeType classifies supported upload-only videos and rejects others', () => {
  assert.equal(videoMimeType({type: 'video/mp4', name: 'clip.mp4'}), 'video/mp4');
  assert.equal(videoMimeType({type: 'video/x-m4v', name: 'clip.m4v'}), 'video/mp4');
  assert.equal(videoMimeType({type: 'video/quicktime', name: 'clip.mov'}), 'video/quicktime');
  assert.equal(videoMimeType({type: '', name: 'Clip.MOV'}), 'video/quicktime', 'empty MIME falls back to extension');
  assert.equal(videoMimeType({type: 'application/octet-stream', name: 'clip.webm'}), 'video/webm');
  assert.equal(videoMimeType({type: 'image/png', name: 'shot.mp4'}), '', 'an image MIME is never a video');
  assert.equal(videoMimeType({type: 'video/x-msvideo', name: 'old.avi'}), '', 'unsupported video containers are rejected');
  assert.equal(isVideoAttachment({type: 'application/pdf', name: 'doc.pdf'}), false);
});

for (const kind of ['chrome', 'firefox']) {
  test(`${kind}: byte policy verifies video signatures and blocks renamed content`, async () => {
    const context = vm.createContext({atob, TextDecoder, Uint8Array, URL});
    vm.runInContext(await fs.readFile(new URL(`../src/${kind}/src/content/file-upload-policy.js`, import.meta.url), 'utf8'), context);
    const {validateUploadFile: validate} = context.__wbFileUploadPolicy;

    const accepted = [
      ['mp4 by MIME', 'video/mp4', payload(mp4, 'clip.mp4', 'video/mp4')],
      ['mp4 by extension', '.mp4', payload(mp4, 'clip.mp4', 'video/mp4')],
      ['m4v extension accepts mp4 bytes', '.m4v', payload(mp4, 'clip.m4v', 'video/mp4')],
      ['mov by MIME', 'video/quicktime', payload(mov, 'clip.mov', 'video/quicktime')],
      ['webm by MIME', 'video/webm', payload(webm, 'clip.webm', 'video/webm')],
      ['webm by extension', '.webm', payload(webm, 'clip.webm', 'video/webm')],
      ['video wildcard accepts mp4', 'video/*', payload(mp4, 'clip.mp4', 'video/mp4')],
      ['OR list picks the verified type', 'image/png,video/mp4', payload(mp4, 'clip.mp4', 'video/mp4')],
    ];
    for (const [label, accept, file] of accepted) {
      const result = validate(accept, file);
      assert.equal(result.success, true, `${kind}: ${label} should be accepted`);
    }

    const rejected = [
      ['quicktime bytes against mp4-only accept', 'video/mp4', payload(mov, 'clip.mov', 'video/quicktime')],
      ['webm bytes renamed .mp4', '.mp4', payload(webm, 'clip.mp4', 'video/mp4')],
      ['jpeg bytes renamed .mp4', '.mp4', payload(jpeg, 'clip.mp4', 'video/mp4')],
      ['png bytes with video MIME', 'video/mp4', payload(png, 'clip.mp4', 'video/mp4')],
      ['unrecognised bytes with declared video MIME', 'video/mp4', payload(garbage, 'clip.mp4', 'video/mp4')],
      ['unrecognised bytes with .mp4 extension', '.mp4', payload(garbage, 'clip.mp4', 'video/mp4')],
      ['mp4 bytes against image wildcard', 'image/*', payload(mp4, 'clip.mp4', 'video/mp4')],
    ];
    for (const [label, accept, file] of rejected) {
      const result = validate(accept, file);
      assert.equal(result.success, false, `${kind}: ${label} should be rejected`);
    }
  });

  test(`${kind}: video attachments stay upload-only and expose a run handle`, async () => {
    const AgentClass = kind === 'chrome' ? ChromeAgent : FirefoxAgent;
    const agent = new AgentClass({});
    const tabId = kind === 'chrome' ? 23001 : 23002;
    const enriched = {role: 'user', content: 'post this clip to X'};
    const attachment = {
      kind: 'video',
      name: '../clip.mp4',
      dataUrl: `data:video/mp4;base64,${mp4.toString('base64')}`,
      mimeType: 'video/mp4',
      size: mp4.length,
    };

    const result = await agent._applyAttachments(enriched, [attachment], {name: 'text-model', supportsVision: false}, {
      tabId,
      canUseScratchpadTool: true,
      canUseUploadTool: true,
    });
    assert.equal(result.ok, true, `${kind} should accept a video in Act mode`);

    const blocks = enriched.content;
    const notice = blocks.find(block => block?.text?.startsWith('[UNTRUSTED USER ATTACHMENTS'));
    assert.ok(notice, `${kind} should add the attachment boundary for a video-only upload`);
    const attachmentId = [...agent._userAttachmentHandles.get(tabId).keys()][0];
    assert.ok(notice.text.includes(`${attachmentId} (../clip.mp4)`), `${kind} should pair the handle with the sanitized name`);
    assert.match(notice.text, /upload_file with its attachmentId/);
    assert.match(notice.text, /Video attachments are upload-only: their contents are not visible to you/,
      `${kind} should tell the model the video contents are not visible inside the untrusted notice`);
    assert.equal(blocks.some(block => block?.type === 'image_url' || block?.type === 'document'), false,
      `${kind} must not send the video to the model as an image or document`);

    const payloadResult = agent._resolveUserAttachment(tabId, attachmentId);
    assert.equal(payloadResult.ok, true, `${kind} should resolve the video handle for upload_file`);
    assert.equal(payloadResult.mimeType, 'video/mp4');
    assert.equal(payloadResult.filename, 'clip.mp4', `${kind} should strip path components`);
    assert.equal(payloadResult.size, mp4.length);

    const rejected = await agent._applyAttachments({role: 'user', content: 'post this clip'}, [attachment], {name: 'x'}, {
      tabId: tabId + 100,
      canUseScratchpadTool: true,
      canUseUploadTool: false,
    });
    assert.equal(rejected.ok, false, `${kind} should reject a video when upload_file is unavailable (Ask mode)`);
    assert.match(rejected.error, /upload-only/);
    assert.match(rejected.error, /Act mode/);
  });
}

test('X public composer binds no recipient, on the upload path or any other', () => {
  for (const [label, policy, publicComposer] of [['chrome', chromePolicy, chromePublicComposer], ['firefox', firefoxPolicy, firefoxPublicComposer]]) {
    assert.equal(publicComposer('https://x.com/compose/post'), true, `${label}: X compose is a public composer`);
    assert.equal(publicComposer('https://x.com/compose/tweet'), true, `${label}: legacy tweet compose is a public composer`);
    assert.equal(publicComposer('https://x.com/i/chat/123'), false, `${label}: X DM is never a public composer`);
    assert.equal(publicComposer('https://x.com/home'), false, `${label}: timeline is not a public composer`);
    // A public post has no recipient, so no tool on the route binds one: the
    // generic /compose/ path rule must not reclaim it and refuse the Post
    // click as recipient_identity_unavailable. What is published stays gated
    // by the publication contract and audit (see
    // test/social-publish-contract.mjs).
    assert.equal(policy('https://x.com/compose/post'), null,
      `${label}: click, press_keys and set_field on X compose carry no recipient to verify`);
    assert.equal(policy('https://x.com/i/chat/123')?.verifyActiveRecipient, true, `${label}: X DM stays protected`);
    assert.equal(policy('https://x.com/messages/compose')?.verifyActiveRecipient, true, `${label}: DM compose stays protected`);
  }
});

test('video kind survives every attachment allowlist in both trees', async () => {
  const files = [
    'src/chrome/src/background.js',
    'src/firefox/src/background.js',
    'src/chrome/src/ui/chat-history-store.js',
    'src/firefox/src/ui/chat-history-store.js',
    'src/chrome/src/trace/recorder.js',
    'src/firefox/src/trace/recorder.js',
    'src/chrome/src/agent/agent.js',
    'src/firefox/src/agent/agent.js',
    'src/chrome/src/ui/sidepanel.js',
    'src/firefox/src/ui/sidepanel.js',
  ];
  for (const file of files) {
    const source = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /\['image', 'document', 'text', 'video'\]/, `${file} must keep the video kind`);
  }
  for (const file of ['src/chrome/src/ui/sidepanel.html', 'src/firefox/src/ui/sidepanel.html']) {
    const html = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(html, /video\/mp4,video\/quicktime,video\/webm/, `${file} must offer video files`);
  }
});
