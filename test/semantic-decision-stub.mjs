// Stands in for the model in unit tests. It answers WebBrain's fixed-choice
// language decisions (src/*/src/agent/semantic-decisions.js) and its
// consequential-action authorization, and records what each question saw.
//
// `defaultDecide` is a small English oracle for the fixtures' own requests,
// the way a model would read them. Tests about a specific verdict pass their
// own `decide`; the product itself never reads requests with word lists.
import assert from 'node:assert/strict';
import { SEMANTIC_QUESTIONS } from '../src/chrome/src/agent/semantic-decisions.js';

export function semanticQuestionOf(agent, messages) {
  const data = JSON.parse(agent._unwrapUntrusted(messages.at(-1).content));
  return {
    request: JSON.parse(messages[1].content).request,
    page: data.page,
    ...(Array.isArray(data.items) ? { items: data.items } : {}),
    system: messages[0].content,
    wrapped: messages.at(-1).content,
  };
}

// Questions about page texts, read item by item with the fixture oracles
// below (the answer quotes each item, as a model must).
const PAGE_TEXT_ORACLES = {
  control_effect: item => fixtureControlEffectReading(item?.text),
  control_repeat: item => fixtureControlRepeatReading(item?.text),
  message_control: item => fixtureMessageControlReading(item?.text),
  message_field: item => fixtureMessageFieldReading(item?.text),
  message_author: item => fixtureMessageAuthorReading(item?.text),
  message_status: item => fixtureMessageStatusReading(item?.text),
  status_message: item => fixtureStatusReading(item?.text),
  workflow_state: item => fixtureWorkflowStateReading(item?.state, item?.text),
  form_field_match: item => fixtureFormFieldMatchReading(item?.named, item?.text),
  follow_state: item => fixtureFollowStateReading(item?.text),
  progress_action: item => fixtureProgressActionReading(item?.text, item?.action),
  metadata_field: item => fixtureWorkflowFieldReading('metadata_field', item?.text),
  publication_field: item => fixtureWorkflowFieldReading('publication_field', item?.text),
  review_thread_control: item => fixtureReviewThreadControlReading(item?.text),
  page_blocker: item => fixturePageBlockerReading(item?.text),
};

const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];

export function defaultDecide(kind, { request, page, items }) {
  if (Array.isArray(items) && PAGE_TEXT_ORACLES[kind]) {
    return { answers: items.flatMap((item, index) => {
      const choice = PAGE_TEXT_ORACLES[kind](item);
      return choice ? [{ item: index, choice, evidence: String(item?.text ?? '') }] : [];
    }) };
  }
  const text = String(request || '');
  if (kind === 'deletion_request') {
    if (/\b(?:don'?t|do not|never|without)\b[^.]*\b(?:delet|remov)/i.test(text)) return { choice: 'forbidden', evidence: text };
    if (!/\b(?:delete|remove|trash|erase)\b/i.test(text)) return { choice: 'not_requested', evidence: '' };
    if (page?.earlierResultOfThisTask) return { choice: 'delete_this', evidence: text };
    // A linked item is named by its link; a request that links something else
    // means another item.
    if (page?.link && text.includes(page.link)) return { choice: 'delete_this', evidence: text };
    if (page?.link && /https?:\/\//i.test(text)) return { choice: 'other_item', evidence: '' };
    const siblings = new Set((page?.siblings || []).flatMap(words));
    const requested = new Set(words(text));
    const own = words(page?.item).filter(word => requested.has(word) && !siblings.has(word)
      && !['delete', 'remove', 'from', 'with', 'this', 'that', 'item', 'cart'].includes(word));
    return own.length ? { choice: 'delete_this', evidence: text } : { choice: 'unclear', evidence: '' };
  }
  if (kind === 'deletion_prerequisite') {
    return /\b(?:delete|remove)\b(?![^.]*\b(?:characters?|hashtags?|words?|symbols?|marks?)\b)/i.test(text)
      ? { choice: 'delete_previous', evidence: text } : { choice: 'keep_previous', evidence: '' };
  }
  if (kind === 'sending_forbidden') {
    return /\b(?:don'?t|do not|never)\s+send\b/i.test(text) ? { choice: 'forbidden', evidence: text } : { choice: 'not_forbidden', evidence: '' };
  }
  return null;
}

export const authorizeAll = ({ input, authority }) => ({ key: input.key, authorized: true, latestRequestEvidence: authority.latestAcceptedRequest });

// Replace the agent's model calls. `decide(kind, question)` returns
// { choice, evidence }, a bare choice string, or null (no answer).
// `authorize({ input, authority, system })` answers the publication and
// submission authorization check.
export function installModelStub(agent, { decide = defaultDecide, authorize = authorizeAll, provider = null } = {}) {
  const calls = [];
  agent._chatWithCostAllowance = async (usedProvider, messages, _options, _cost, meta) => {
    if (provider) assert.equal(usedProvider, provider);
    const name = String(meta?.generationName || '');
    if (name.startsWith('semantic_')) {
      const kind = name.slice('semantic_'.length);
      const question = semanticQuestionOf(agent, messages);
      calls.push({ kind, ...question });
      const answer = await decide(kind, question);
      if (answer == null) throw new Error('No model answer.');
      return { content: JSON.stringify(typeof answer === 'string' ? { choice: answer, evidence: question.request } : answer) };
    }
    if (name === 'resource_mutation_authorization') {
      const input = JSON.parse(agent._unwrapUntrusted(messages.at(-1).content));
      const authority = JSON.parse(messages[1].content);
      calls.push({ kind: 'authorization', input, authority, system: messages[0].content });
      return { content: JSON.stringify(await authorize({ input, authority, system: messages[0].content })) };
    }
    throw new Error(`Unexpected model call ${name}.`);
  };
  return calls;
}

// For scripted providers that answer every request from a fixed script: the
// fixed-choice questions WebBrain asks on its own (what a short turn does,
// whether a request forbids an action) get no answer here, as from a model
// that cannot tell, instead of consuming the script.
export const FIXED_CHOICE_QUESTION = "Answer one fixed-choice question for a browser agent's safety check.";
export function withoutFixedChoiceAnswers(chat) {
  return (messages, options) => String(messages?.[0]?.content || '').startsWith(FIXED_CHOICE_QUESTION)
    ? Promise.resolve({ content: JSON.stringify({ choice: '', evidence: '' }) })
    : chat(messages, options);
}

// Which fixed-choice question a request asks, read from the question's own
// text, and whether it asks it about a list of items.
export function fixedChoiceQuestion(messages) {
  const system = String(messages?.[0]?.content || '');
  if (!system.startsWith(FIXED_CHOICE_QUESTION)) return null;
  const kind = Object.entries(SEMANTIC_QUESTIONS).find(([, spec]) => system.includes(spec.instructions))?.[0] || null;
  let request = '', data = {};
  try { request = JSON.parse(messages[1].content).request; } catch {}
  try {
    const wrapped = String(messages.at(-1).content);
    const json = wrapped.slice(wrapped.indexOf('{'), wrapped.lastIndexOf('}') + 1);
    data = JSON.parse(json);
  } catch {}
  return { kind, request, batch: Array.isArray(data.items), items: data.items || [], page: data.page || {} };
}

// Answers the named fixed-choice questions the way a model that read them
// would. `answers[kind]` is a choice, { choice, evidence }, or a function of
// ({ request, page, item }) returning either (or null for no answer). A
// choice without evidence quotes the whole request. Questions not named get
// no answer, as from a model that cannot tell.
export function withFixedChoiceAnswers(chat, answers = {}) {
  const answerFor = async (kind, question) => {
    const entry = answers[kind];
    const value = typeof entry === 'function' ? await entry(question) : entry;
    if (value == null || value === '') return null;
    return typeof value === 'string' ? { choice: value, evidence: question.request } : value;
  };
  return async (messages, options) => {
    const question = fixedChoiceQuestion(messages);
    if (!question) return chat(messages, options);
    if (!question.kind) return { content: JSON.stringify({ choice: '', evidence: '' }) };
    if (question.batch) {
      const list = [];
      for (const [item, entry] of question.items.entries()) {
        const answer = await answerFor(question.kind, { request: question.request, item: entry });
        if (answer) list.push({ item, ...answer });
      }
      return { content: JSON.stringify({ answers: list }) };
    }
    const answer = await answerFor(question.kind, { request: question.request, page: question.page });
    return { content: JSON.stringify(answer || { choice: '', evidence: '' }) };
  };
}

// The calculation fixtures' requests, read the way a model would: which
// expression they ask for, whether they ask for anything else, and the form
// they set for the answer (texts copied exactly from the request).
export const CALCULATION_FORM_PROMPT = 'The user\'s request in `request` asks a browser agent only to calculate';
export function withCalculationReadings(chat, read) {
  const readings = withFixedChoiceAnswers(chat, {
    calculation_request: question => read(question.request, question.page.expression)?.choice || null,
  });
  return async (messages, options) => {
    if (String(messages?.[0]?.content || '').startsWith(CALCULATION_FORM_PROMPT)) {
      const { request, expression } = JSON.parse(messages[1].content);
      const form = read(request, expression)?.form;
      return { content: JSON.stringify(form || {}) };
    }
    return readings(messages, options);
  };
}

// How a model reads the fixtures' own page texts: the status a page showed
// after a submit, and whether a text shows a site workflow's last step as
// done. A small English oracle for the test fixtures, the way a model would
// read them; the product never reads these words.
export function fixtureStatusReading(text) {
  const value = String(text || '');
  if (/\b(?:not|never|failed|failure|error|unable|cannot|invalid|rejected|denied|unsuccessful|required)\b/i.test(value)) return 'error';
  if (/\b(?:will be|is being|pending|loading|sending|saving)\b/i.test(value)) return 'other';
  if (/\b(?:success(?:ful|fully)?|saved|submitted|created|sent|published|completed|updated|uploaded|added|approved|resolved|received|confirmed|recorded|accepted|thank you|done|zapisano)\b/i.test(value)) return 'success';
  return 'other';
}

const FIXTURE_WORKFLOW_STATES = [
  [/draft/i, /\bdraft\s+(?:auto[- ]?)?saved\b|\bsaved\s+draft\b|草稿已保存|下書きを保存しました|taslak kaydedildi/i],
  [/message was sent/i, /\bmessage\s+sent\b|消息发送成功|消息已发送|发送成功|ileti gönderildi/i],
  [/submitted and received/i, /\bresponse\s+(?:was\s+)?submitted\b|\bapplication\s+(?:was\s+)?(?:submitted|received)\b|\bthank you for (?:submitting|applying)\b|提交成功|başvurunuz alındı/i],
  [/changes were saved/i, /\bchanges?\s+saved\b|\bsaved successfully\b|保存成功|başarıyla kaydedildi|zapisano (?:wszystkie )?zmiany/i],
  [/resolved/i, /\b(?:conversation|thread|review)\s+(?:was\s+)?(?:marked\s+as\s+)?resolved\b|已解决|çözüldü/i],
  [/uploaded or attached/i, /\b(?:uploaded|attached|upload (?:complete|successful))\b|yüklendi|eklendi|hochgeladen|przesłano|已上传|上傳完成|アップロード済み|업로드됨/iu],
];
export function fixtureWorkflowStateReading(state, text) {
  const value = String(text || '');
  if (/\b(?:not|never|failed|failure|error|unable|cannot)\b|发送失败|未发送/i.test(value)) return 'failed';
  const shown = FIXTURE_WORKFLOW_STATES.find(([meaning]) => meaning.test(String(state || '')))?.[1];
  return shown?.test(value) ? 'reached' : 'other';
}

// How a model reads the fixtures' own control captions (the control_effect
// question): what activating a control labelled so does. A small oracle for
// the test fixtures, the way a model would read them; the product never reads
// these words.
const END = '(?=$|[\\s!.,:;?…])';
const WORD = '(?:^|[^\\p{L}])';
const WEND = '(?=[^\\p{L}]|$)';
const DELETE_WORDS = 'delete|remove|trash|erase|destroy|discard|sil|kaldır|supprimer|eliminar|borrar|löschen|entfernen|удалить|törlés|törlése|radera|删除|刪除|削除|삭제';
const BULK_WORDS = 'all|selected|checked|everything|bulk|tüm\\p{L}*|hepsi\\p{L}*|seçil\\p{L}*|tous|toutes|sélectionn\\p{L}*|todos|todas|seleccionad\\p{L}*|alle|ausgewählt\\p{L}*|все|выбранн\\p{L}*';
export function fixtureControlEffectReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const has = words => new RegExp(`${WORD}(?:${words})${WEND}`, 'iu').test(value);
  const hasCjk = /删除|刪除|削除|삭제|送信|发送|發送|보내/u.test(value);
  if (/^(?:compose(?: new)? post|new post|new message|cancel|keep editing|close|back|open|show more|more|menu|settings)$/i.test(value)) return 'view';
  // "More …", "Menu …" and "… actions" buttons open a menu, whatever they
  // name.
  if (/^(?:more|menu|options)\s/i.test(value) || /\s(?:actions|options|menu)$/i.test(value)) return 'view';
  if (has('remove|clear|kaldır|temizle') && has('filters?|filtre\\p{L}*|filtro\\p{L}*|фильтр\\p{L}*|facets?|sort(?:ing)?|search(?:es)?|quer(?:y|ies)|selection|formatting')
    && !has('delete|trash|erase|destroy|sil|supprimer|eliminar|borrar|löschen|удалить')) return 'view';
  if (has(DELETE_WORDS) || /删除|刪除|削除|삭제/u.test(value)) {
    if (has(BULK_WORDS)) return 'delete_many';
    if (has('remove|kaldır|discard') && has('attachments?|attached|files?|images?|photos?|pictures?|media|videos?|gifs?|uploads?|documents?|draft|ek(?:i|ler\\p{L}*)?|dosya\\p{L}*|görsel\\p{L}*|resim\\p{L}*|fotoğraf\\p{L}*|medya\\p{L}*')) return 'form_edit';
    if (has('discard')) return 'form_edit';
    return 'delete_one';
  }
  if (new RegExp(`^(?:continue|next|sign in|log in|devam|ileri|weiter|suivant|siguiente|次へ)${END}`, 'iu').test(value)) return 'next_step';
  if (has('post|post all|publish|reply|tweet|yayınla|yanıtla|paylaş|publier|publicar|veröffentlichen')) return 'publish';
  if (/^add to (?:cart|bag|basket)\b/i.test(value)) return 'commit';
  if (new RegExp(`^(?:add|choose|select|attach|insert|format|bold|italic|ekle|seç)${END}`, 'iu').test(value) || /emoji|gif|sticker/i.test(value)) return 'form_edit';
  // "Bookmark" saves the post it belongs to, as a model reads it (QA P1).
  if (has('save|submit|send|confirm|commit|resolve|pay|purchase|buy|checkout|place order|confirm order|complete order|create|update|apply|finish|done|sign up|register|bookmark|gönder|kaydet|onayla|öde|enviar|guardar|envoyer|enregistrer|senden|speichern|verzenden|invia|zapisz|отправить|إرسال|ارسال|保存|提交') || hasCjk) return 'commit';
  if (/^(?:search|filter|go|ara|suchen|buscar|rechercher|cerca|zoeken|filtrele|検索|搜索)$/iu.test(value)) return 'view';
  return 'unclear';
}

// How a model reads the name of an element whose first click changed
// nothing visible (the control_repeat question): whether a second click could
// act twice or undo itself. A small oracle for the test fixtures, the way a
// model would read them; the product never reads these words.
export function fixtureControlRepeatReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (/(?:^|[^\p{L}])(?:send|submit|save|buy|pay|order now|book now|place order|delete|remove|publish|share|like|follow|subscribe|block|report|accept|invite|install|sign up|download|export|gönder|kaydet|sil|kaldır|öde|satın al|takip et|beğen|löschen|senden|supprimer|envoyer|eliminar|enviar|törlés|törlése|radera|διαγραφή)(?=$|[^\p{L}])|削除|送信|删除|发送|삭제/iu.test(value)) return 'changes';
  return 'harmless';
}

// How a model reads the fixtures' own messaging control names (the
// message_control question): whether activating a control so named sends
// something to someone, opens an editor, or only works on a draft or the
// conversation. A small oracle for the test fixtures, the way a model would
// read them; the product never reads these words.
const MESSAGE_TOOL_NAMES = new RegExp(
  '^(?:save\\s*(?:&|and)?\\s*(?:close|draft|draft\\s*&\\s*close)|save\\s*&\\s*close'
  + '|minimi[sz]e|exit\\s+full\\s+screen|full\\s+screen|pop-?out|expand|collapse'
  + '|discard(?:\\s+draft)?|delete\\s+draft|print|check\\s+spelling|plain\\s+text(?:\\s+mode)?'
  + '|attach(?:\\s+(?:files?|photos?|images?|documents?))?|insert\\s+(?:link|photo|image|file|drive|emoji|signature|contact|table|drawing|note)'
  + '|emoji|emoticon|bold|italic|underline|strikethrough|align|numbered\\s+list|bulleted\\s+list'
  + '|indent|outdent|undo|redo|more\\s+options|formatting(?:\\s+options)?|text\\s+formatting'
  + '|remove\\s+formatting|font|text\\s+color|highlight|edit\\s+subject|confidential\\s+mode'
  + '|add\\s+(?:an?\\s+)?(?:photos?|images?|pictures?|videos?|files?|attachments?|media|gifs?|stickers?)'
  + '(?:\\s+(?:or|and|&)\\s+(?:an?\\s+)?(?:photos?|images?|pictures?|videos?|files?|gifs?|stickers?))?'
  + '|choose\\s+(?:an?\\s+)?(?:emojis?|gifs?|stickers?)(?:\\s+(?:or|and|&)\\s+(?:an?\\s+)?(?:emojis?|gifs?|stickers?))?'
  + '|(?:open\\s+)?(?:gif|sticker)s?(?:\\s+picker)?$'
  + '|(?:fotoğraf|resim|görsel|video|dosya|medya)(?:\\s+(?:veya|ya\\s+da|ve)\\s+(?:fotoğraf|resim|video|dosya))?\\s+ekle'
  + '|(?:emoji|gif|çıkartma)(?:\\s+(?:veya|ya\\s+da)\\s+(?:emoji|gif|çıkartma))?\\s+seç'
  + '|(?:foto|bild|video|datei|anhang)(?:\\s+oder\\s+(?:foto|bild|video))?\\s+hinzufügen|emoji\\s+auswählen'
  + '|(?:añadir|agregar|adicionar)\\s+(?:una?\\s+)?(?:foto|imagen|imagem|vídeo|video|archivo|arquivo)'
  + '|ajouter\\s+(?:une?\\s+)?(?:photo|image|vidéo|fichier)|choisir\\s+un\\s+emoji'
  + '|photo$|video$)(?=$|[\\s,.:;!?…])',
  'iu',
);
const CONVERSATION_TOOL_NAMES = /^(?:call|(?:voice|video|audio)\s+call|start\s+(?:a\s+)?(?:voice|video)\s+call|search|menu|more|settings|back|close|arama|ara|suchen|rechercher|buscar|llamar|appel|anrufen)(?=$|[\s,.:;!?…])/iu;
export function fixtureMessageControlReading(text) {
  const value = String(text || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (new RegExp(`${WORD}(?:send|enviar|envoyer|invia|senden|verzenden|gönder\\p{L}*|отправить)${WEND}`, 'iu').test(value)
      || /送信|发送|發送|보내|إرسال|ارسال/u.test(value)) return 'send';
  if (/^(?:reply|reply all|forward|yanıtla|tümünü yanıtla|ilet|antworten|weiterleiten|répondre|transférer|responder|reenviar)$/iu.test(value)) return 'reply';
  if (/^(?:start a post|create a post|new post|write article|gönderi başlat\p{L}*)$/iu.test(value)) return 'new_post';
  if (/^(?:compose|compose message|new message|new chat|message|new email|yeni mesaj|mesaj)$/iu.test(value)) return 'new_message';
  if (/^(?:post|post all|publish|tweet|repost|yayınla|paylaş)$/iu.test(value)) return 'publish';
  if (MESSAGE_TOOL_NAMES.test(value)) return 'draft_tool';
  if (CONVERSATION_TOOL_NAMES.test(value)) return 'conversation_tool';
  return 'other';
}

// How a model reads the fixtures' own message editor field names (the
// message_field question), message labels (message_author) and sent-message
// statuses (message_status). Small oracles for the test fixtures, the way a
// model would read them; the product never reads these words.
export function fixtureMessageFieldReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (/(?:^|[^\p{L}])(?:bcc|blind carbon copy|gizli)(?=[^\p{L}]|$)/iu.test(value)) return 'bcc';
  if (/(?:^|[^\p{L}])(?:cc|carbon copy|bilgi)(?=[^\p{L}]|$)/iu.test(value)) return 'cc';
  if (/(?:^|[^\p{L}])(?:to|recipients?|send to|e-?mail(?: address)?|destinatario|destinataria|destinataire|para|aan|kime|alıcı\p{L}*|do|til|komu)(?=[^\p{L}]|$)|收件人|宛先|받는\s*사람|إلى/iu.test(value)) return 'to';
  if (/(?:^|[^\p{L}])(?:subject|konu)(?=[^\p{L}]|$)/iu.test(value)) return 'subject';
  if (/(?:^|[^\p{L}])(?:body|message body)(?=[^\p{L}]|$)/iu.test(value)) return 'body';
  return 'other';
}
export function fixtureMessageAuthorReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return /^(?:you(?:\s+sent\b|[:,])|outgoing message\b|sent by you\b|siz:|gönderdiğiniz)/iu.test(value) ? 'self' : 'other';
}
export function fixtureMessageStatusReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (/^(?:read|delivered|seen|okundu|iletildi|görüldü)$/iu.test(value)) return 'delivered';
  if (/^(?:sent|gönderildi)$/iu.test(value)) return 'sent';
  if (/^(?:pending|sending|failed|bekliyor)$/iu.test(value)) return 'pending';
  return 'unclear';
}

// How a model reads which detail of an edited item (metadata_field) or which
// part of a publication (publication_field) a field label or page line holds,
// for the fixtures' own labels: the label equals a known name, contains it as
// whole words, or (for a name outside Latin scripts) contains it at all. The
// first field in this order wins. The product never matches these words.
const FIXTURE_WORKFLOW_FIELD_NAMES = [
  ['alt_text', ['alt text', 'alternative text', 'image alt text', 'attachment alt text', 'media alt text']],
  ['paid_promotion', ['paid promotion', 'promotion payée', 'contenido promocional pagado', 'promoção paga', 'bezahlte werbung', 'promozione a pagamento', 'ücretli tanıtım', '有料プロモーション', '유료 프로모션', '付费宣传', '付費宣傳']],
  ['recording_date', ['recording date', 'date recorded', "date d’enregistrement", 'fecha de grabación', 'data de gravação', 'aufnahmedatum', 'data di registrazione', 'kayıt tarihi', '録画日', '撮影日', '촬영 날짜', '录制日期', '錄製日期']],
  ['recording_location', ['recording location', 'video location', "lieu d’enregistrement", 'ubicación de grabación', 'local de gravação', 'aufnahmeort', 'luogo di registrazione', 'kayıt konumu', '撮影場所', '촬영 위치', '录制地点', '錄製地點']],
  ['comments', ['comment', 'comments', 'commentaire', 'commentaires', 'comentario', 'comentarios', 'kommentar', 'kommentare', 'commento', 'commenti', 'yorum', 'yorumlar', 'komentarze', 'コメント', '댓글', '评论', '評論', 'комментарии']],
  ['embedding', ['embedding', 'embed', 'intégration', 'incorporation', 'einbetten', 'incorporamento', 'yerleştirme', 'umieszczanie', '埋め込み', '퍼가기', '嵌入', 'встраивание']],
  ['description', ['description', 'descripción', 'descrição', 'beschreibung', 'descrizione', 'açıklama', 'opis', '説明', '설명', '描述', 'описание']],
  ['visibility', ['visibility', 'privacy', 'visibilité', 'confidentialité', 'visibilidad', 'privacidad', 'visibilidade', 'privacidade', 'sichtbarkeit', 'visibilità', 'görünürlük', 'widoczność', '公開設定', '公開範囲', '可視性', '공개 상태', '공개 설정', '可见性', '可見度', 'видимость']],
  ['audience', ['audience', 'made for kids', 'audiencia', 'destinado a niños', 'público', 'conteúdo para crianças', 'zielgruppe', 'für kinder', 'pubblico', 'destinato ai bambini', 'kitle', 'çocuklara özel', 'odbiorcy', '視聴者', '子ども向け', '시청자', '아동용', '受众', '面向儿童', '觀眾', '兒童專用', 'аудитория']],
  ['playlist', ['playlist', 'playlists', 'liste de lecture', 'listes de lecture', 'lista de reproducción', 'listas de reproducción', 'lista de reprodução', 'listas de reprodução', 'wiedergabeliste', 'wiedergabelisten', 'elenco di riproduzione', 'elenchi di riproduzione', 'oynatma listesi', 'oynatma listeleri', 'playlisty', '再生リスト', '재생목록', '播放列表', 'плейлист', 'плейлисты']],
  ['language', ['language', 'langue', 'idioma', 'sprache', 'lingua', 'dil', 'język', '言語', '언어', '语言', '語言', 'язык']],
  ['category', ['category', 'catégorie', 'categoría', 'kategorie', 'categoria', 'kategori', 'kategoria', 'カテゴリ', '카테고리', '类别', '類別', 'категория']],
  ['license', ['license', 'licence', 'licencia', 'lizenz', 'licenza', 'lisans', 'licencja', 'ライセンス', '라이선스', '许可', '授權', 'лицензия']],
  ['tag', ['tag', 'choose a tag', 'choose tag', 'git tag', 'release tag']],
  ['tags', ['tags', 'étiquette', 'étiquettes', 'mot clé', 'mots clés', 'etiqueta', 'etiquetas', 'schlagwort', 'schlagwörter', 'etichette', 'etiket', 'etiketler', 'tagi', 'タグ', '태그', '标签', '標籤', 'теги']],
  ['notes', ['notes', 'release notes', 'release note', 'release body', 'describe this release', '发行说明', '發行說明', 'リリースノート', '릴리스 노트']],
  ['account', ['account', 'profile', 'handle', 'username', 'publishing account', 'posting account']],
  ['attachment', ['attachment', 'attachments', 'attach', 'attached', 'media', 'medias', 'image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'video', 'videos', 'clip', 'clips', 'file', 'files', 'pièce jointe', 'pièces jointes', 'médias', 'adjunto', 'adjuntos', 'medios', 'imagen', 'imágenes', 'foto', 'fotos', 'anexo', 'anexos', 'mídia', 'mídias', 'imagem', 'imagens', 'anhang', 'anhänge', 'medien', 'bild', 'bilder', 'allegato', 'allegati', 'immagine', 'immagini', 'ek', 'ekler', 'medya', 'görsel', 'resim', '添付', '添付ファイル', '画像', '写真', '動画', 'メディア', '첨부', '첨부파일', '이미지', '사진', '동영상', '미디어', '附件', '图片', '圖片', '照片', '相片', '视频', '視頻', '影片', '媒体', '媒體', 'вложение', 'вложения', 'медиа', 'изображение', 'изображения', 'фото', 'видео']],
  ['body', ['body', 'post', 'post body', 'post text', 'composer']],
  ['path', ['path', 'file path', 'repository path']],
  ['branch', ['branch', 'git branch']],
  ['commit_message', ['commit message', 'commit summary', 'commit title']],
  ['title', ['title', 'titre', 'título', 'titulo', 'titel', 'titolo', 'başlık', 'tytuł', 'タイトル', '제목', '标题', '標題', 'название']],
];
const fixtureFieldText = value => {
  let text = String(value || '');
  try { text = text.normalize('NFKC'); } catch {}
  return text.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
};
export function fixtureWorkflowFieldReading(kind, label) {
  const choices = SEMANTIC_QUESTIONS[kind]?.choices;
  const text = fixtureFieldText(label);
  if (!choices || !text) return null;
  const padded = ` ${text} `;
  const field = FIXTURE_WORKFLOW_FIELD_NAMES.filter(([key]) => Object.hasOwn(choices, key)).find(([, names]) => names
    .map(fixtureFieldText).some(name => name && (text === name || padded.includes(` ${name} `)
      || (/[^\u0000-ɏ]/u.test(name) && text.includes(name)))))?.[0];
  return field || 'other';
}

// How a model reads whether a code review page's button resolves a review
// conversation (review_thread_control), for the fixtures' own labels. The
// product never matches these words.
export function fixtureReviewThreadControlReading(text) {
  let value = String(text || '');
  try { value = value.normalize('NFKC'); } catch {}
  value = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!value) return null;
  return /^(?:resolve (?:conversation|thread)|resolver (?:la )?(?:conversaci[oó]n|conversa|conversação)|r[ée]soudre (?:la )?(?:conversation|discussion)|(?:unterhaltung|konversation|diskussion) aufl[öo]sen|risolvi (?:la )?conversazione|konuşmayı çöz|rozwiąż (?:konwersację|wątek)|解决对话|解決對話|解决此对话|会話を解決(?:する)?|スレッドを解決(?:する)?|대화 ?해결|스레드 ?해결|разрешить (?:обсуждение|беседу))$/u
    .test(value) ? 'resolve' : 'other';
}

// How a model reads what a dialog or overlay asks of the person using the
// page (page_blocker), for the fixtures' own titles and texts: a check that
// they are human, or a subscription, registration or sign-in wall in front of
// an article. The product never matches these words.
export function fixturePageBlockerReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!value) return null;
  if (/captcha|security verification|human verification|verif(?:y|ication)[^.]{0,24}(?:human|robot)|are you (?:a )?human|confirm you are human|robot check|challenge verification|güvenlik doğrulaması|robot olmadığınızı|insan olduğunuzu|weryfikacja bezpieczeństwa|nie jesteś robotem|安全验证|人机验证/.test(value)) return 'human_check';
  // A wall says the article stops until the reader acts; an offer beside
  // readable text does not.
  const wall = /continue reading|to read (?:this|the) (?:full )?(?:article|story)|subscriber[- ]only|unlock (?:this|the) (?:article|story)|okumaya devam|devamını okumak|weiterlesen|weiterzulesen|lire la suite|la suite est réservée|continuar leyendo|czytać dalej/.test(value);
  if (!wall) return 'other';
  if (/subscri|abone|abonn|suscr|prenumer|trial/.test(value)) return 'subscription';
  if (/create (?:a )?(?:free )?account|register|sign up|hesap oluştur|kayıt ol|konto erstellen|registrier|créez un compte|załóż konto/.test(value)) return 'registration';
  if (/log ?in|sign in|giriş yap|anmelden|connectez|zaloguj/.test(value)) return 'login';
  return 'other';
}

// How a model reads a fediverse page's follow controls and fields
// (follow_state), whether a request names a domain as the user's own server
// (home_instance), and whether a clicked label does a ledger action
// (progress_action), for the fixtures' own texts. The product never matches
// these words.
export function fixtureFollowStateReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (/^(?:following|unfollow|requested|takip ediliyor|takibi bırak|gefolgt|entfolgen|abonniert)\b/iu.test(value)) return 'following';
  if (/^(?:follow|takip et|folgen|suivre|seguir)\b/iu.test(value)) return 'follow';
  if (/(?:server|instance|domain|sunucu|alan adı)/iu.test(value)) return 'home_server';
  return 'other';
}
export function fixtureHomeInstanceReading(request, domain) {
  const text = String(request || ''), name = String(domain || '').toLowerCase();
  if (!name) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`(?:\\b(?:my|home|own|from|via|using)\\b[^.]{0,48}${escaped}|${escaped}\\s*(?:sunucumdan|sunucumda|örneğimden|hesabımdan)|(?:meine[mn]?|von meinem)[^.]{0,40}${escaped})`, 'iu');
  return named.test(text) ? 'home' : 'other';
}
const LEDGER_ACTION_WORDS = {
  follow: /^(?:follow|takip et|folgen)\b/iu, unfollow: /^(?:unfollow|takibi bırak|entfolgen)\b/iu, star: /^star\b/iu,
  unstar: /^unstar\b/iu, connect: /^(?:connect|bağlantı kur|vernetzen)\b/iu, like: /^(?:like|beğen)\b/iu,
  unlike: /^unlike\b/iu, subscribe: /^(?:subscribe|abone ol)\b/iu, unsubscribe: /^unsubscribe\b/iu, save: /^save\b/iu,
  send: /^send\b/iu, submit: /^submit\b/iu, add: /^add\b/iu, remove: /^remove\b/iu, block: /^block\b/iu,
  unblock: /^unblock\b/iu, report: /^report\b/iu, watch: /^watch\b/iu, unwatch: /^unwatch\b/iu, unsave: /^unsave\b/iu,
};
export function fixtureProgressActionReading(text, actionContext) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const action = String(actionContext || '').split(':')[0].trim();
  if (!value || !LEDGER_ACTION_WORDS[action]) return null;
  if (LEDGER_ACTION_WORDS[action].test(value)) return 'did';
  const opposite = action.startsWith('un') ? action.slice(2) : `un${action}`;
  if (LEDGER_ACTION_WORDS[opposite]?.test(value)) return 'undid';
  return 'other';
}

// How a model reads whether a form field is the one a request named
// (form_field_match), for the fixtures' own texts: the content words of one
// side all appear on the other, once the page's "optional" marks and the
// words a request wraps around a field are set aside, and a few Turkish names
// stand for their English fields. The product never matches these words.
const FORM_FIELD_FILLER = new Set([
  'optional', 'required', 'opcional', 'obligatorio', 'facultatif', 'obligatoire', 'zorunlu', 'isteğe', 'bağlı',
  'please', 'attach', 'upload', 'add', 'provide', 'include', 'enter', 'fill', 'set', 'put', 'write', 'answer',
  'select', 'my', 'me', 'i', 'the', 'a', 'an', 'your', 'our', 'this', 'that', 'and', 'or', 'to', 'in', 'on', 'at',
  'of', 'for', 'with', 'as', 'is', 'be', 'field', 'question', 'box', 'section', 'form', 'file', 'document',
  'here', 'ekle', 'yükle', 'yaz', 'alanı', 'alanına',
]);
const FORM_FIELD_SYNONYMS = new Map([['ön', 'cover'], ['yazı', 'letter'], ['yazımı', 'letter'], ['özgeçmiş', 'resume'],
  ['özgeçmişimi', 'resume'], ['işveren', 'employer'], ['adı', 'name'], ['yanıt', 'reply']]);
const formFieldTokens = value => {
  let text = String(value ?? '');
  try { text = text.normalize('NFKC'); } catch {}
  return text.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
    .map(token => FORM_FIELD_SYNONYMS.get(token) || token)
    .filter(token => token.length > 1 && !FORM_FIELD_FILLER.has(token));
};
export function fixtureFormFieldMatchReading(named, label) {
  const wanted = formFieldTokens(named), own = formFieldTokens(label);
  if (!wanted.length || !own.length) return null;
  const wholeWanted = wanted.join(' '), wholeOwn = own.join(' ');
  if (wholeOwn.includes(wholeWanted) && wanted.length > 1) return 'same';
  // One content word only names a field it heads.
  const covers = (subset, superset) => subset.every(token => superset.includes(token))
    && (subset.length > 1 || (superset.length <= 2 && superset[0] === subset[0]));
  return covers(wanted, own) || covers(own, wanted) || wholeOwn === wholeWanted ? 'same' : 'different';
}

// Runs the recipient guard's page check (or a chat observation) the way the
// agent does: texts it consulted unread are read by a model (the fixture
// oracles by default), and the check runs again with those readings, up to
// three times while it reaches texts nobody has read. `evaluate(params)` runs
// the check in the page and returns its result; `read(kind, text)` gives a
// reading or null for no answer.
export async function guardProbeWithReadings(evaluate, params = {}, read = fixturePageTextReading) {
  const readings = {};
  for (const [kind, texts] of Object.entries(params.__wbPageReadings || {})) readings[kind] = { ...texts };
  let result = await evaluate({ ...params, __wbPageReadings: readings });
  for (let pass = 0; pass < 3; pass += 1) {
    const needed = Array.isArray(result?.pageTextsNeeded) ? result.pageTextsNeeded : [];
    let readAny = false;
    for (const { kind, text } of needed) {
      const choice = read(kind, text);
      if (choice) { (readings[kind] ??= {})[text] = choice; readAny = true; }
    }
    if (!readAny) break;
    result = await evaluate({ ...params, __wbPageReadings: readings });
  }
  return result;
}

// Runs the submit probe the way the agent does: a collect pass reports the
// activated control's unread captions, a model (the fixture oracle by
// default) reads them, and a final pass decides with those readings.
// `evaluate(toolName, args)` runs the probe in the page and returns its
// result.
export async function probeWithReadings(evaluate, toolName, args = {}, read = fixtureControlEffectReading) {
  const readings = { ...(args.__wbCaptionReadings || {}) };
  const first = await evaluate(toolName, { ...args, __wbCaptionPass: 'collect', __wbCaptionReadings: readings });
  const needed = Array.isArray(first?.captionsNeeded) ? first.captionsNeeded : [];
  if (!needed.length) return first;
  for (const caption of needed) {
    const choice = read(caption);
    if (choice) readings[caption] = choice;
  }
  return evaluate(toolName, { ...args, __wbCaptionPass: 'final', __wbCaptionReadings: readings });
}

// Stands in for the model that reads page texts in unit tests (status
// messages, workflow states, validation alerts): `read(kind, item)` returns a
// choice or null for no answer. Records every item asked.
export function stubPageTextReadings(agent, read = (kind, item, request) => (kind === 'status_message'
  ? fixtureStatusReading(item.text) : kind === 'workflow_state' ? fixtureWorkflowStateReading(item.state, item.text)
    : kind === 'control_effect' ? fixtureControlEffectReading(item.text)
      : kind === 'control_repeat' ? fixtureControlRepeatReading(item.text)
        : fixturePageTextReading(kind, item.text, { ...item, request }))) {
  const asked = [];
  agent._semanticDecisions = async (_tabId, kind, { items = [], request = '' } = {}) => items.map(item => {
    asked.push({ kind, ...item });
    const choice = read(kind, item, request);
    return choice ? { choice, evidence: item.text, source: 'decision_model' } : { choice: null, evidence: '', source: 'unavailable' };
  });
  return asked;
}

// The reply a model would give, in a fixture run, to one of WebBrain's
// fixed-choice questions sent to a fake provider (`messages` as the provider
// receives them), or null when the request is not such a question. Page-text
// questions are read with the fixture oracles above; any other question gets
// no answer unless `answers[kind]` gives one, as from a model that cannot tell.
export function fixtureFixedChoiceReply(messages, answers = {}) {
  const question = fixedChoiceQuestion(messages);
  if (!question) return null;
  const read = (item) => {
    if (typeof answers[question.kind] === 'function') return answers[question.kind]({ request: question.request, item, page: question.page });
    if (question.kind === 'status_message') return fixtureStatusReading(item?.text);
    if (question.kind === 'workflow_state') return fixtureWorkflowStateReading(item?.state, item?.text);
    if (question.kind === 'control_effect') return fixtureControlEffectReading(item?.text);
    if (question.kind === 'control_repeat') return fixtureControlRepeatReading(item?.text);
    if (['message_control', 'message_field', 'message_author', 'message_status', 'form_field_match', 'follow_state',
      'progress_action', 'metadata_field', 'publication_field', 'review_thread_control', 'page_blocker'].includes(question.kind)) {
      return fixturePageTextReading(question.kind, item?.text, item);
    }
    if (question.kind === 'home_instance') return fixtureHomeInstanceReading(question.request, item?.text);
    return answers[question.kind] ?? null;
  };
  const evidenceOf = item => (typeof item?.text === 'string' ? item.text : typeof item?.label === 'string' ? item.label : question.request);
  if (question.batch) {
    const list = [];
    question.items.forEach((item, index) => {
      const answer = read(item);
      if (!answer) return;
      list.push(typeof answer === 'string' ? { item: index, choice: answer, evidence: evidenceOf(item) } : { item: index, ...answer });
    });
    return JSON.stringify({ answers: list });
  }
  const answer = read(null);
  return JSON.stringify(!answer ? { choice: '', evidence: '' }
    : typeof answer === 'string' ? { choice: answer, evidence: question.request } : answer);
}

// The readings a model would have given the fixtures' page texts, for unit
// tests of the synchronous checks that use remembered readings (stand-in for
// Agent#_pageTextReading after _readPageTexts).
export function fixturePageTextReading(kind, text, context = {}) {
  if (kind === 'status_message') return fixtureStatusReading(text);
  if (kind === 'workflow_state') return fixtureWorkflowStateReading(context?.state, text);
  if (kind === 'control_effect') return fixtureControlEffectReading(text);
  if (kind === 'control_repeat') return fixtureControlRepeatReading(text);
  if (kind === 'message_control') return fixtureMessageControlReading(text);
  if (kind === 'message_field') return fixtureMessageFieldReading(text);
  if (kind === 'message_author') return fixtureMessageAuthorReading(text);
  if (kind === 'message_status') return fixtureMessageStatusReading(text);
  if (kind === 'form_field_match') return fixtureFormFieldMatchReading(context?.named, text);
  if (kind === 'follow_state') return fixtureFollowStateReading(text);
  if (kind === 'home_instance') return fixtureHomeInstanceReading(context?.request, text);
  if (kind === 'progress_action') return fixtureProgressActionReading(text, context?.action);
  if (kind === 'metadata_field' || kind === 'publication_field') return fixtureWorkflowFieldReading(kind, text);
  if (kind === 'review_thread_control') return fixtureReviewThreadControlReading(text);
  if (kind === 'page_blocker') return fixturePageBlockerReading(text);
  return null;
}

// Only the page-text questions (status messages, workflow states, control
// captions and names), for fake providers that answer WebBrain's other
// fixed-choice questions themselves.
export function fixturePageTextReply(messages) {
  const kind = fixedChoiceQuestion(messages)?.kind;
  return ['status_message', 'workflow_state', 'control_effect', 'control_repeat', 'message_control', 'message_field',
    'message_author', 'message_status', 'form_field_match', 'follow_state', 'home_instance', 'progress_action',
    'metadata_field', 'publication_field', 'review_thread_control', 'page_blocker'].includes(kind) ? fixtureFixedChoiceReply(messages) : null;
}
