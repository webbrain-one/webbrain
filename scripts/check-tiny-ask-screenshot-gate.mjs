// Hardware eval for the tiny Ask screenshot gate: the in-browser model's own
// Yes/No readout on whether a question needs a screenshot of the current page
// (src/chrome/src/agent/tiny-ask.js, tinyAskScreenshotGate). Runs labelled
// questions in several languages through the real extension's decision path
// and reports accuracy, latency and every miss.
//
//   node scripts/check-tiny-ask-screenshot-gate.mjs --profile <profile with the model cached> \
//     --adapter-luid 0,82094 --output .build/tiny-ask-gate/result.json
//
// --extension DIR    unpacked extension (default src/chrome); use a fresh profile per build
// --model ID         in-browser model (default Compass VLD Tiny v5; Ternary Bonsai 2 2B
//                    Vision is webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision)
// --threshold P      Yes threshold to report (default TINY_ASK_SCREENSHOT_GATE_THRESHOLD)
// --dataset FILE     labelled rows from scripts/models/bonsai/gate_dataset.py instead of
//                    the built-in cases ({label, language, question, pageChars, ...})
// --return-hidden    also record each row's margin and hidden state, for
//                    scripts/models/bonsai/train_gate_probe.py
// --follow-ups       short follow-ups to a turn answered from a screenshot, scored
//                    at TINY_ASK_SCREENSHOT_FOLLOW_UP_THRESHOLD (the readout sees
//                    only the follow-up; the earlier question is for the reader)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  tinyAskScreenshotGate, tinyAskScreenshotGateProbability, TINY_ASK_SCREENSHOT_FOLLOW_UP_THRESHOLD, TINY_ASK_SCREENSHOT_GATE_THRESHOLD,
} from '../src/chrome/src/agent/tiny-ask.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const extension = path.resolve(option('--extension', path.join(root, 'src/chrome')));
const profile = path.resolve(option('--profile', '.build/tiny-ask-gate/profile'));
const output = path.resolve(option('--output', '.build/tiny-ask-gate/result.json'));
const model = option('--model', 'webbrain-one/webbrain-compass-vld-tiny-v5-onnx');
const followUps = args.includes('--follow-ups');
const threshold = Number(option('--threshold', followUps ? TINY_ASK_SCREENSHOT_FOLLOW_UP_THRESHOLD : TINY_ASK_SCREENSHOT_GATE_THRESHOLD));

// [expected, language, question, context]. Expected Yes: the answer depends on
// what the current page visibly shows. Pages have text unless `pageChars` says
// otherwise.
const TEXT_PAGE = { pageChars: 5000 };
const TEXTLESS = { pageChars: 0 };
const CASES = [
  // Visual questions about the current page.
  [true, 'en', 'What color is the Buy button?', TEXT_PAGE],
  [true, 'en', 'What does the chart on this page show?', TEXT_PAGE],
  [true, 'en', 'Describe the photo at the top.', TEXT_PAGE],
  [true, 'en', 'Is the logo red or blue?', TEXT_PAGE],
  [true, 'en', 'How does this page look on my screen?', TEXT_PAGE],
  [true, 'tr', 'Satın al butonu ne renk?', TEXT_PAGE],
  [true, 'tr', 'Bu sayfadaki grafik ne gösteriyor?', TEXT_PAGE],
  [true, 'tr', 'Fotoğraftaki kupa ne renk?', TEXT_PAGE],
  [true, 'de', 'Welche Farbe hat der Kaufen-Knopf?', TEXT_PAGE],
  [true, 'de', 'Was zeigt das Diagramm auf dieser Seite?', TEXT_PAGE],
  [true, 'es', '¿De qué color es el botón de compra?', TEXT_PAGE],
  [true, 'es', '¿Qué muestra la foto de esta página?', TEXT_PAGE],
  [true, 'fr', 'De quelle couleur est le logo ?', TEXT_PAGE],
  [true, 'fr', 'Que montre le graphique sur cette page ?', TEXT_PAGE],
  [true, 'it', 'Di che colore è il pulsante Acquista?', TEXT_PAGE],
  [true, 'pt', 'O que mostra a imagem desta página?', TEXT_PAGE],
  [true, 'ja', 'このページの画像には何が写っていますか？', TEXT_PAGE],
  [true, 'ar', 'ما لون زر الشراء في هذه الصفحة؟', TEXT_PAGE],
  // Questions about a page with almost no text.
  [true, 'en', 'What is on this page?', TEXTLESS],
  [true, 'tr', 'Bu sayfada ne var?', TEXTLESS],
  [true, 'de', 'Was ist auf dieser Seite zu sehen?', TEXTLESS],
  [true, 'es', 'Resume esta página.', TEXTLESS],
  // Mixed sources that name the current page.
  [true, 'en', 'Compare the attached image with the logo on this page.', { ...TEXT_PAGE, imageAttachment: true }],
  [true, 'tr', 'Eklediğim resim bu sayfadaki logoya benziyor mu?', { ...TEXT_PAGE, imageAttachment: true }],
  // Answered from the page text.
  [false, 'en', 'How much is the Pro plan per month?', TEXT_PAGE],
  [false, 'en', 'Summarize this page in two sentences.', TEXT_PAGE],
  [false, 'en', 'When did the repairs end?', TEXT_PAGE],
  [false, 'en', 'Who wrote this article?', TEXT_PAGE],
  [false, 'tr', 'Pro planı aylık ne kadar?', TEXT_PAGE],
  [false, 'tr', 'Bu sayfayı özetle.', TEXT_PAGE],
  [false, 'de', 'Wie viel kostet der Pro-Tarif im Monat?', TEXT_PAGE],
  [false, 'de', 'Fasse diese Seite zusammen.', TEXT_PAGE],
  [false, 'es', '¿Cuánto cuesta el plan Pro al mes?', TEXT_PAGE],
  [false, 'fr', 'Résume cette page en deux phrases.', TEXT_PAGE],
  [false, 'it', 'Quando è stato pubblicato questo articolo?', TEXT_PAGE],
  [false, 'pt', 'Quanto custa o plano Pro por mês?', TEXT_PAGE],
  [false, 'ja', 'このページを要約してください。', TEXT_PAGE],
  [false, 'ar', 'لخص هذه الصفحة.', TEXT_PAGE],
  // General knowledge, including visual-sounding questions.
  [false, 'en', 'What does melanoma look like?', TEXT_PAGE],
  [false, 'en', 'Explain what melanoma looks like.', TEXTLESS],
  [false, 'en', 'Who was Ada Lovelace?', TEXTLESS],
  [false, 'en', 'What color is a flamingo?', TEXT_PAGE],
  [false, 'en', 'How do I treat a burn?', TEXT_PAGE],
  [false, 'tr', 'Melanom nasıl görünür?', TEXT_PAGE],
  [false, 'tr', 'Ada Lovelace kimdir?', TEXTLESS],
  [false, 'de', 'Wie sieht ein Flamingo aus?', TEXT_PAGE],
  [false, 'es', '¿Qué es la fotosíntesis?', TEXT_PAGE],
  [false, 'fr', 'Quelle est la capitale du Japon ?', TEXTLESS],
  [false, 'ja', '富士山の高さは？', TEXT_PAGE],
  [false, 'ar', 'من هو ابن سينا؟', TEXT_PAGE],
  // Only about an attached image or a linked page.
  [false, 'en', 'What is in this image?', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'tr', 'Bu resimde ne var?', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'de', 'Beschreibe dieses Bild.', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'en', 'What color is the logo at https://brand.example/about?', { ...TEXT_PAGE, linkedPage: true }],
  [false, 'es', 'Resume https://news.example/launch en una frase.', { ...TEXT_PAGE, linkedPage: true }],
];

// Follow-ups: [language, earlier question answered from a screenshot,
// [follow-ups that need another look], [follow-ups that do not]]. The
// threshold was chosen on the first set and the pronoun set below, and
// checked on the second, which adds languages (sv, id, vi, hi) and phrasings
// the first never uses.
const FOLLOW_UPS_CHOSEN_ON = [
  ['en', 'What colour is the banner?', ['And the button?', 'What about the logo?', 'Is it darker than the header?', 'Which one is bigger?'],
    ['How much is the Team plan?', 'Who wrote this article?', 'Thanks!', 'Who was Alan Turing?']],
  ['en', 'Describe the photo at the top.', ['What colour is it?', 'How many people are in it?', 'And the second picture?', 'Is anyone smiling?'],
    ['Summarise the page.', 'When was this published?', 'What is the phone number here?', 'Tell me a short joke.']],
  ['tr', 'Afiş ne renk?', ['Peki buton?', 'Ya logo?', 'Daha koyu mu?'], ['Ekip paketi ne kadar?', 'Teşekkürler!', 'Alan Turing kimdir?']],
  ['tr', 'Fotoğrafta ne var?', ['Kaç kişi var?', 'Sağdaki ne?'], ['Bu sayfayı özetle.', 'Makale ne zaman yayımlandı?']],
  ['de', 'Welche Farbe hat das Logo?', ['Und der Knopf?', 'Ist es dunkler als der Hintergrund?'], ['Wie viel kostet der Team-Tarif?', 'Danke!']],
  ['es', '¿De qué color es el logo?', ['¿Y el botón?', '¿Y la foto de abajo?'], ['¿Cuánto cuesta el plan Team?', '¡Gracias!']],
  ['fr', 'Que montre la photo ?', ["Et l'autre ?", 'De quelle couleur ?'], ["Combien coûte l'offre Team ?", 'Merci !']],
  ['it', 'Di che colore è il logo?', ['E il pulsante?'], ['Quanto costa il piano Team?']],
  ['pt', 'O que mostra a imagem?', ['E a de baixo?'], ['Quanto custa o plano Team?']],
  ['ru', 'Какого цвета логотип?', ['А кнопка?'], ['Сколько стоит тариф Team?']],
  ['ja', 'この写真には何が写っていますか？', ['背景は何色？', '右のは？'], ['チームプランはいくら？', 'ありがとう！']],
  ['zh', '这张图片里有什么？', ['那背景呢？'], ['团队版多少钱？']],
  ['ar', 'ما لون الشعار؟', ['والزر؟'], ['كم سعر خطة الفريق؟']],
  ['ko', '로고는 무슨 색이에요?', ['버튼은요?', '배경은요?'], ['팀 요금제는 얼마예요?', '고마워요!']],
  ['nl', 'Welke kleur heeft het logo?', ['En de knop?'], ['Hoeveel kost het Team-abonnement?']],
  ['pl', 'Jakiego koloru jest logo?', ['A przycisk?'], ['Ile kosztuje plan Team?']],
];
const FOLLOW_UPS_CHECKED_ON = [
  ['en', 'Is the logo round?', ['And the icon next to it?', 'Is the text on it white?', 'What shape is the button below?', 'How about on the right?'],
    ['What does the refund policy say?', 'Can you translate the intro?', 'What is the capital of Peru?', 'Great, thank you.']],
  ['en', 'What does the chart show?', ['Which bar is the tallest?', 'What colour is the line?', 'Is the trend going up?'],
    ['Who is the author?', 'What are the opening hours?', 'OK.']],
  ['tr', 'Logo yuvarlak mı?', ['Yanındaki simge?', 'Üstündeki yazı beyaz mı?', 'Grafikteki en uzun çubuk hangisi?'],
    ['İade politikası ne diyor?', "Peru'nun başkenti neresi?", 'Tamam, sağ ol.']],
  ['de', 'Was zeigt das Bild oben?', ['Und unten links?', 'Welche Farbe hat das Auto darin?'], ['Wer hat den Artikel geschrieben?', 'Was ist die Hauptstadt von Peru?']],
  ['es', '¿Qué muestra el gráfico?', ['¿Cuál es la barra más alta?', '¿Y la línea roja?'], ['¿Quién es el autor?', 'Vale, gracias.']],
  ['fr', 'Le logo est-il rond ?', ["Et l'icône à côté ?"], ['Que dit la politique de remboursement ?']],
  ['it', 'Cosa mostra la foto?', ['Quante persone ci sono?'], ["Chi è l'autore?"]],
  ['pt', 'De que cor é o botão?', ['E o fundo?'], ['Qual é o horário de funcionamento?']],
  ['ru', 'Что на фотографии?', ['А справа?'], ['Кто автор статьи?']],
  ['ja', 'ロゴは丸いですか？', ['隣のアイコンは？'], ['返金ポリシーは？']],
  ['zh', '图表显示了什么？', ['哪个柱子最高？'], ['作者是谁？']],
  ['ar', 'ماذا تظهر الصورة؟', ['وعلى اليمين؟'], ['من هو الكاتب؟']],
  ['sv', 'Vilken färg har knappen?', ['Och bakgrunden?'], ['Vad kostar Team-planen?']],
  ['id', 'Apa warna tombolnya?', ['Kalau logonya?'], ['Berapa harga paket Team?']],
  ['vi', 'Nút có màu gì?', ['Còn nền thì sao?'], ['Gói Team giá bao nhiêu?']],
  ['hi', 'बटन किस रंग का है?', ['और लोगो?'], ['टीम प्लान की कीमत क्या है?']],
  ['ko', '사진에 뭐가 있어요?', ['오른쪽은요?'], ['작성자가 누구예요?']],
];
// Follow-ups that point back with a pronoun, to the mug on the image task's
// page. Added after "How much does it hold?" took a screenshot in
// check-webgpu-ask.mjs (it scores 0.73 alone, above the usual bar too); used
// to pick 0.4 over 0.35, which said yes to two more of the text ones.
const FOLLOW_UPS_PRONOUNS = [
  ['en', 'What colour is the mug in the photo?',
    ['Is it shiny?', 'Does it have a handle?', 'What shape is it?', 'Is it bigger than the heading?', 'Is there anything printed on it?', 'Which way does the handle point?'],
    ['How much does it hold?', 'Is it dishwasher safe?', 'How long does it keep drinks warm?', 'How much does it cost?', 'Where can I buy it?', 'Is it in stock?', 'Who makes it?', 'When was it released?']],
  ['tr', 'Fotoğraftaki kupa ne renk?', ['Kulpu var mı?', 'Parlak mı?', 'Şekli nasıl?'], ['Ne kadar alıyor?', 'Bulaşık makinesinde yıkanır mı?', 'Fiyatı ne?', 'Stokta var mı?']],
  ['de', 'Welche Farbe hat die Tasse auf dem Foto?', ['Hat sie einen Henkel?', 'Welche Form hat sie?'], ['Wie viel passt hinein?', 'Ist sie spülmaschinenfest?', 'Was kostet sie?']],
  ['es', '¿De qué color es la taza de la foto?', ['¿Tiene asa?', '¿Qué forma tiene?'], ['¿Cuánto cabe?', '¿Se puede lavar en el lavavajillas?', '¿Cuánto cuesta?']],
  ['fr', 'De quelle couleur est la tasse sur la photo ?', ['A-t-elle une anse ?'], ['Combien contient-elle ?', 'Va-t-elle au lave-vaisselle ?']],
  ['ja', '写真のマグカップは何色ですか？', ['取っ手はありますか？'], ['容量はどれくらい？', '食洗機で洗えますか？']],
  ['ko', '사진 속 머그컵은 무슨 색이에요?', ['손잡이가 있어요?'], ['용량이 얼마예요?', '가격이 얼마예요?']],
  ['nl', 'Welke kleur heeft de mok op de foto?', ['Heeft hij een oor?'], ['Hoeveel past erin?']],
];
const followUpRows = (pairs, set) => pairs.flatMap(([language, earlier, visual, text]) => [
  ...visual.map(question => [true, language, question, { ...TEXT_PAGE, set, earlier }]),
  ...text.map(question => [false, language, question, { ...TEXT_PAGE, set, earlier }]),
]);

const returnHidden = args.includes('--return-hidden');
const rows = option('--dataset', '')
  ? JSON.parse(await fs.readFile(option('--dataset'), 'utf8')).map(row => [Boolean(row.label), row.language, row.question,
    { pageChars: row.pageChars, imageAttachment: row.imageAttachment === true, linkedPage: row.linkedPage === true }])
  : followUps ? [...followUpRows(FOLLOW_UPS_CHOSEN_ON, 'chosen on'), ...followUpRows(FOLLOW_UPS_PRONOUNS, 'pronouns'),
    ...followUpRows(FOLLOW_UPS_CHECKED_ON, 'checked on')]
    : CASES;
const result = { model, extension, threshold, dataset: option('--dataset', ''), startedAt: new Date().toISOString(), cases: [] };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--enable-unsafe-webgpu', '--force-high-performance-gpu',
      ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  // Decision fixtures and D1 controls answer only the Settings page.
  await harness.goto(`chrome-extension://${id}/src/ui/settings.html#decision`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ onboardingComplete: true, wbLocale: 'en', helpImproveWebBrain: false }));
  result.extensionVersion = await harness.evaluate(() => chrome.runtime.getManifest().version);
  const preset = (await import('../src/chrome/src/providers/webgpu.js')).webgpuModelPreset(model);
  await message('update_provider', { providerId: 'webgpu', config: { model, dtype: preset.dtype } });
  const status = await message('get_webgpu_download_status', { model });
  if (!status?.ready) throw new Error(`${model} is not cached in this profile`);
  for (const [index, [expected, language, question, facts]] of rows.entries()) {
    const { set: _set, earlier: _earlier, ...gateFacts } = facts;
    const gate = tinyAskScreenshotGate({ question, ...gateFacts });
    const started = Date.now();
    const reply = await message('webgpu_decide_fixture', { fixture: { ...gate, promptVariant: 'gate', returnHidden } });
    const seconds = (Date.now() - started) / 1000;
    const probability = tinyAskScreenshotGateProbability(reply?.result?.answers);
    const entry = {
      expected, language, question, ...facts, probability,
      predicted: probability >= threshold, seconds, ...(reply?.success ? {} : { error: reply?.error || 'no reply' }),
      ...(returnHidden ? { margin: reply?.result?.answers?.needs_screenshot?.margins?.[0] ?? null,
        hidden: reply?.result?.answers?.needs_screenshot?.hidden?.[0] ?? null } : {}),
    };
    entry.correct = entry.error ? false : entry.predicted === expected;
    if (index > 0) result.cases.push(entry); else result.cold = entry;
    if (!returnHidden || index % 25 === 0) console.log(JSON.stringify({ index, ok: entry.correct, p: entry.probability?.toFixed(3), s: seconds, language, question }));
  }
  // The first call loads the model; score it, but keep it out of the latency.
  const all = [result.cold, ...result.cases];
  const latency = result.cases.map(entry => entry.seconds).sort((a, b) => a - b);
  const share = (rows, test) => `${rows.filter(test).length}/${rows.length}`;
  result.summary = {
    accuracy: share(all, entry => entry.correct),
    yesRecall: share(all.filter(entry => entry.expected), entry => entry.predicted),
    falseYes: share(all.filter(entry => !entry.expected), entry => entry.predicted),
    byLanguage: Object.fromEntries([...new Set(all.map(entry => entry.language))]
      .map(language => [language, share(all.filter(entry => entry.language === language), entry => entry.correct)])),
    latencySeconds: { p50: latency[Math.floor(latency.length / 2)], p95: latency[Math.floor(latency.length * 0.95)] },
    misses: all.filter(entry => !entry.correct).map(entry => ({ expected: entry.expected, p: entry.probability, question: entry.question })),
  };
  if (followUps) {
    result.summary.bySet = Object.fromEntries(['chosen on', 'pronouns', 'checked on'].map(set => {
      const rows = all.filter(entry => entry.set === set);
      return [set, { yesRecall: share(rows.filter(entry => entry.expected), entry => entry.predicted),
        falseYes: share(rows.filter(entry => !entry.expected), entry => entry.predicted) }];
    }));
  }
  console.log(JSON.stringify(result.summary, null, 1));
} catch (error) {
  result.error = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await context?.close().catch(() => {});
}
