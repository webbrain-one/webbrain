// Runtime-owned notice: no model call is needed to translate a transport outcome.
export const outputLimitNotices = Object.freeze({
  en: "This reply reached the model's output limit and was cut off. Ask WebBrain to continue to get the rest.",
  ar: 'وصل هذا الرد إلى حد إخراج النموذج وانقطع. اطلب من WebBrain المتابعة للحصول على الباقي.',
  bn: 'এই উত্তরটি মডেলের আউটপুট সীমায় পৌঁছে কেটে গেছে। বাকি অংশ পেতে WebBrain-কে চালিয়ে যেতে বলুন।',
  de: 'Diese Antwort wurde am Ausgabelimit des Modells abgeschnitten. Bitte WebBrain um Fortsetzung, um den Rest zu erhalten.',
  es: 'Esta respuesta alcanzó el límite de salida del modelo y se cortó. Pide a WebBrain que continúe para obtener el resto.',
  fa: 'این پاسخ به محدودیت خروجی مدل رسید و قطع شد. برای دریافت بقیه، از WebBrain بخواهید ادامه دهد.',
  fr: 'Cette réponse a atteint la limite de sortie du modèle et a été coupée. Demandez à WebBrain de continuer pour obtenir la suite.',
  he: 'התשובה הגיעה למגבלת הפלט של המודל ונקטעה. בקשו מ-WebBrain להמשיך כדי לקבל את ההמשך.',
  hi: 'यह उत्तर मॉडल की आउटपुट सीमा तक पहुँचकर कट गया। बाकी पाने के लिए WebBrain से जारी रखने को कहें।',
  id: 'Jawaban ini mencapai batas keluaran model dan terpotong. Minta WebBrain melanjutkan untuk mendapatkan sisanya.',
  it: 'Questa risposta ha raggiunto il limite di output del modello ed è stata interrotta. Chiedi a WebBrain di continuare per ricevere il resto.',
  ja: 'この回答はモデルの出力上限に達したため途中で切れました。残りを取得するには、WebBrain に続きを依頼してください。',
  ko: '이 답변은 모델의 출력 한도에 도달하여 잘렸습니다. 나머지를 받으려면 WebBrain에 계속해 달라고 요청하세요.',
  ms: 'Jawapan ini mencapai had output model dan terpotong. Minta WebBrain meneruskan untuk mendapatkan selebihnya.',
  nl: 'Dit antwoord heeft de uitvoerlimiet van het model bereikt en is afgebroken. Vraag WebBrain verder te gaan om de rest te krijgen.',
  pl: 'Ta odpowiedź osiągnęła limit wyjścia modelu i została ucięta. Poproś WebBrain o kontynuację, aby otrzymać resztę.',
  pt: 'Esta resposta atingiu o limite de saída do modelo e foi cortada. Peça ao WebBrain para continuar e obter o restante.',
  ru: 'Ответ достиг лимита вывода модели и был обрезан. Попросите WebBrain продолжить, чтобы получить оставшуюся часть.',
  th: 'คำตอบนี้ถึงขีดจำกัดเอาต์พุตของโมเดลและถูกตัดออก ขอให้ WebBrain ตอบต่อเพื่อรับส่วนที่เหลือ',
  tl: 'Naabot ng sagot na ito ang limitasyon ng output ng modelo at naputol. Hilingin sa WebBrain na magpatuloy para makuha ang natitira.',
  tr: 'Bu yanıt modelin çıktı sınırına ulaştığı için kesildi. Kalanını almak için WebBrain’den devam etmesini isteyin.',
  uk: 'Відповідь досягла ліміту виводу моделі й була обрізана. Попросіть WebBrain продовжити, щоб отримати решту.',
  vi: 'Câu trả lời đã đạt giới hạn đầu ra của mô hình và bị cắt. Hãy yêu cầu WebBrain tiếp tục để nhận phần còn lại.',
  zh: '此回复已达到模型的输出上限并被截断。请让 WebBrain 继续，以获取剩余内容。',
});

export function outputLimitNotice(locale = 'en') {
  const language = String(locale || 'en').replace(/_/g, '-').toLowerCase().split('-')[0];
  return Object.hasOwn(outputLimitNotices, language) ? outputLimitNotices[language] : outputLimitNotices.en;
}
