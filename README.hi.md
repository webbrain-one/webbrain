<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain लोगो" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  ओपन-सोर्स AI ब्राउज़र एजेंट — पेजों से बातचीत करें, कार्य स्वचालित करें, और अपनी पसंद के LLM के साथ कई चरणों वाले वर्कफ़्लो चलाएँ।
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Chrome Web Store से WebBrain इंस्टॉल करें"></a>
  <a href="https://addons.mozilla.org/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Firefox Browser Add-ons से WebBrain इंस्टॉल करें"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Microsoft Edge Add-ons से WebBrain इंस्टॉल करें"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.hi.md">हिन्दी</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.tr.md">Türkçe</a> ·
  <a href="docs/">दस्तावेज़</a> ·
  <a href="https://webbrain.one">वेबसाइट</a> ·
  <a href="https://discord.gg/cgC325ssfw">Discord</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![पेज पढ़ते हुए, फ़ॉर्म भरते हुए और फ़ाइल लाते हुए WebBrain](assets/webbrain-demo.gif)

WebBrain एक वेब ब्राउज़र एक्सटेंशन है जो आपकी टैब्स के बगल में एक साइड पैनल में AI एजेंट रखता है।
जिस पेज पर आप हैं उसके बारे में उससे पूछें, या उसे कोई सौंपें और वह क्लिक, टाइप और नेविगेट करते हुए उसे पूरा करे।
यह आपके चुने मॉडल पर चलता है — लोकल llama.cpp या Ollama सर्वर, एक फ़्रंटियर क्लाउड API,
या मैनेज किया गया डिफ़ॉल्ट जो बिल्कुल भी सेटअप नहीं माँगता।

## इंस्टॉल करें

[Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/webbrain/), या
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo) से इंस्टॉल करें।

<details>
<summary><b>या स्रोत से लोड करें</b></summary>

```bash
git clone --filter=blob:none https://github.com/webbrain-one/webbrain.git
```

**Chrome** — `chrome://extensions/` खोलें, **Developer mode** (ऊपर दाईं ओर) सक्षम करें,
**Load unpacked** पर क्लिक करें, और `webbrain/src/chrome` फ़ोल्डर चुनें।
अलग कॉपी के लिए जो वर्किंग-ट्री की बिखरी हुई फ़ाइलें नहीं उठाएगी, पहले
`npm run build:chrome` चलाएँ और उसके बजाय `webbrain/build/chrome` लोड करें।

**Firefox** — `about:debugging#/runtime/this-firefox` खोलें, **Load
Temporary Add-on** पर क्लिक करें, और `src/firefox/manifest.json` चुनें (या
`npm run build:firefox` चलाने के बाद `build/firefox/manifest.json`)। अस्थायी add-ons
Firefox रीस्टार्ट होने पर हट जाते हैं; स्थायी इंस्टॉलेशन के लिए
[addons.mozilla.org](https://addons.mozilla.org) पर हस्ताक्षर (signing) आवश्यक है।

</details>

## इसका उपयोग करें

WebBrain आइकन पर क्लिक करके साइड पैनल खोलें, फिर कुछ इस तरह टाइप करें:

- "इस पेज का सारांश बताओ"
- "कीमतों से जुड़े सभी लिंक ढूँढो"
- "सर्च बॉक्स में 'AI agents' टाइप करो और Search पर क्लिक करो"
- "github.com पर जाओ और ट्रेंडिंग रिपॉज़िटरी ढूँढो"

तीन मोड यह नियंत्रित करते हैं कि एजेंट क्या कर सकता है:

| मोड    | यह क्या कर सकता है                                                    |
| ------- | ---------------------------------------------------------------------- |
| **Ask** | केवल पढ़ने के लिए। पेज पढ़ता है, सवालों के जवाब देता है, URLs लाता है।  |
| **Act** | क्लिक करता है, टाइप करता है, नेविगेट करता है, अपलोड-डाउनलोड करता है, फ़ॉर्म भरता है। |
| **Dev** | पेज सोर्स, स्टाइल्स, कंसोल, नेटवर्क और वापस ली जा सकने वाली पेज एडिट्स जोड़ता है। |

WebBrain हर संदेश के लिए मोड खुद चुनता है: जब तक आपका संदेश ब्राउज़र में कुछ करने को
न कहे, वह Ask में ही रहता है। संदेश की शुरुआत `/ask`, `/act` या
`/dev` से करके मोड स्वयं चुनें।

## मॉडल चुनें

**WebBrain Compass 1.0** डिफ़ॉल्ट है और इसके लिए न API key चाहिए, न लोकल सेटअप।

**लोकल मॉडल्स** के लिए भी API key नहीं चाहिए। WebBrain को किसी भी OpenAI-compatible
सर्वर की ओर निर्देशित करें:

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Osaurus (`:1337/v1`), Jan (`:1337/v1`), LocalAI (`:8080/v1`), और GPT4All
(`:4891/v1`) इसी तरह काम करते हैं। **WebBrain Companion** लोकल मॉडल्स और समर्थित
अकाउंट सब्सक्रिप्शन के लिए हमारा अलग डेस्कटॉप ऐप है। [इसे
Windows, macOS या Linux के लिए डाउनलोड करें](https://github.com/webbrain-one/webbrain/releases/tag/systray-v0.1.2),
फिर **WebBrain Companion** प्रोवाइडर कार्ड चुनें, **Load Models** पर क्लिक करें,
एक मॉडल चुनें, और कनेक्शन जाँचें। लोकल एंडपॉइंट डिफ़ॉल्ट रूप से
`http://127.0.0.1:8327/v1` है और इस कंप्यूटर पर API key नहीं माँगता। देखें
[Companion सेटअप](docs/providers-and-models.md#webbrain-companion)।
अन्य OpenAI-compatible गेटवेज़ के लिए एक सामान्य **Local OpenAI-compatible Proxy**
कार्ड उपलब्ध रहता है।
**Unsloth Studio (Local)** उसी OpenAI-compatible पथ का उपयोग करता है, बस Studio
पोर्ट और उपयोगकर्ता द्वारा कॉन्फ़िगर किया गया `sk-unsloth-` API key; देखें
[Unsloth Studio सेटअप](docs/providers-and-models.md#unsloth-studio)।
**Osaurus (Local)** मैक के Osaurus सर्वर से मॉडल खोज, स्ट्रीमिंग और टूल कॉल्स के साथ
कनेक्ट होता है; देखें [Osaurus सेटअप](docs/providers-and-models.md#osaurus)।
चुनी गई टियर के सिस्टम प्रॉम्प्ट और टूल स्कीमा, पेज/हिस्ट्री और माँगे गए आउटपुट के
लिए लोड किए गए कॉन्टेक्स्ट विंडो का आकार तय करें। **16k एक कॉन्फ़िगरेशन फ़ॉलबैक है,
गारंटीड न्यूनतम नहीं; Compact के 8k में फ़िट होने की गारंटी नहीं है।**
Mid और Full हिस्ट्री जमा होने से पहले भी 16k पार कर सकते हैं, और compaction
स्थिर निर्देशों या स्कीमा को छोटा नहीं कर सकती। आकार का अनुमान मॉडल का सटीक
टोकनाइज़र नहीं है; देखें [कॉन्टेक्स्ट मार्गदर्शन](docs/providers-and-models.md#local-providers)।
WebBrain llama.cpp, Ollama और LM
Studio के लिए वास्तविक विंडो अपने आप पहचानता है, और बातचीत भरने पर उसे अपने आप
संपीडित (compact) करता है। Ollama, llama.cpp, LM Studio और LocalAI के लिए,
स्क्रीनशॉट जोड़ने से पहले यह नेटिव सर्वर मेटाडेटा भी पढ़ता है; Providers पेज पर
Auto, Force on और Off ओवरराइड्स उपलब्ध हैं। जब वैकल्पिक Model फ़ील्ड खाली हो,
तो हर उपयोगकर्ता टर्न पर लोडेड-मॉडल की क्षमता दोबारा जाँची जाती है, जिससे सर्वर-साइड
हॉट स्वैप असर दिखाए। एक प्रीव्यू `ollama launch webbrain --model <model>`
हैंडऑफ़ भी है। विवरण:
[प्रोवाइडर्स और मॉडल्स](docs/providers-and-models.md#local-providers)।

**क्लाउड APIs** — OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter और भी बहुत कुछ।
Providers पेज पर **Chromium पर 119 बिल्ट-इन प्रोवाइडर कार्ड्स** (Firefox पर 118)
शामिल हैं, जिनमें एंडपॉइंट-मुक्त लोकल WebGPU विकल्प भी है — परीक्षित LFM2.5 2.6B
प्रीसेट और एक प्रायोगिक कस्टम Hugging Face ONNX रिपॉज़िटरी विकल्प के साथ —
देखें [पूरी कैटलॉग](docs/providers-and-models.md#extended-provider-catalog)।

लोकल या bring-your-own प्रोवाइडर के लिए, प्रति-प्रोवाइडर **Share queries for
research** स्विच डिफ़ॉल्ट रूप से बंद ही रहता है। सक्षम करने पर, यह उस प्रोवाइडर के
मॉडल प्रयासों (विफल रन सहित) के लिए एक सीमित, कॉन्टेन्ट-मुक्त निदान टाइमलाइन साझा
करती है, मौजूदा स्क्रब्ड प्रॉम्प्ट/रिस्पॉन्स शेयर के अलावा।
इस टाइमलाइन में टूल नाम, परिणाम, एरर कोड और टाइमिंग शामिल होते हैं, पर टूल
आर्ग्युमेंट्स, पेज कॉन्टेन्ट या स्क्रीनशॉट नहीं। यदि कोई रन सामान्य जेनरेशन शेयर से
पहले विफल हो जाए, तो उसकी सीमित मॉडल--facing रिक्वेस्ट और अंतिम अवरोधक निदान
रिकॉर्ड के साथ जुड़ते हैं। दूसरे शेयरिंग स्विच की आवश्यकता नहीं है;
मौजूदा स्विच बंद करने पर कतार में मौजूद निदान भी मिट जाते हैं।

## फ़ीचर्स

- **कोई भी पेज पढ़ता है** — टेक्स्ट, लिंक, फ़ॉर्म, टेबल्स, PDFs और इंटरैक्टिव
  एलिमेंट्स, नाज़ुक सिलेक्टर्स के बजाय accessibility tree के ज़रिए
- **पेज पर कार्य करता है** — क्लिक, टाइप, स्क्रॉल, नेविगेट, अपलोड, डाउनलोड और
  फ़ॉर्म सत्यापन, महत्वपूर्ण कार्रवाइयों से पहले साइट-वार अनुमति प्रॉम्प्ट्स के साथ
- **Vision मोड** (उर्फ़ "Tesla" मोड) — सिर्फ़ दृष्टि, कैमरों पर चलती Tesla की तरह: इमेज
  लेने वाले मॉडल के साथ, Act पेज को स्क्रीनशॉट्स के रूप में देखता है और निर्देशांकों पर
  क्लिक, टाइप और स्क्रॉल करता है; हर कार्रवाई के बाद केवल स्क्रीन का बदला हुआ हिस्सा
  भेजा जाता है, और retina डिस्प्ले व ब्राउज़र ज़ूम संभाले जाते हैं ([विवरण](docs/vision-mode.md))
- **Act से पहले योजना** — Act और Dev एक संरचित योजना बना सकते हैं, उसे मंज़ूरी के लिए
  दिखा सकते हैं, और किसी टूल के चलने से पहले मंज़ूर की गई योजना scratchpad पर पिन कर सकते हैं
- **मल्टी-स्टेप एजेंट** — स्वचालित टूल-यूज़ लूप, 195 चरणों तक कॉन्फ़िगर करने योग्य
  (डिफ़ॉल्ट 130), सीमा पहुँचने पर Continue बटन के साथ
- **सेव किए वर्कफ़्लो** — किसी सफल रन को दोबारा चलाने, एक्सपोर्ट और शेयर करने योग्य,
  वैल्यू-मुक्त रीयूज़ेबल वर्कफ़्लो में बदलें
- **शेड्यूल्ड टास्क्स और वॉचेस** — बाद के लिए `/schedule`, पेज को पोल करने और शर्त
  पूरी होने पर कार्रवाई करने के लिए `/watch`
- **Skills** — भरोसेमंद निर्देश और टूल्स जो केवल प्रासंगिक होने पर लोड होते हैं
- **स्मार्ट कॉन्टेक्स्ट** — टोकन-जागरूक ऑटो-कम्पैक्शन, टूल-रिज़ल्ट सीमाएँ, और
  आपातकालीन ओवरफ़्लो रिकवरी
- **प्रति-टैब बातचीत** — हर टैब अपना इतिहास रखता है; बताई गई प्राथमिकताओं के लिए
  वैकल्पिक लोकल यूज़र मेमोरी
- **वैकल्पिक क्रॉस-डिवाइस रिकॉल** — लोकल मेमोरी डिफ़ॉल्ट रहते हुए OAuth से MemCode
  जोड़कर रीड-ओनली लुकअप पाएँ ([सेटअप और प्राइवेसी](docs/memcode-recall.md))
- **पढ़ने-को-प्राथमिकता देने वाला साइड पैनल** — स्ट्रीमिंग Ask रिप्लाइज़, तैरते हुए
  कंट्रोल्स जो जवाब बढ़ने पर आपका सवाल नज़र में रखते हैं, कॉपी बटन, पेज-निरीक्षण
  बैनर, और रन के बीच में भी काम करने वाला स्टॉप बटन
- **डिफ़ॉल्ट रूप से नियतिवादी (deterministic)** — ब्राउज़र-कंट्रोल निर्णयों के लिए
  temperature `0.15`, Ask के लिए `0.3`, विज़न स्क्रीनशॉट विवरणों के लिए `0`

## एजेंट टूल्स

WebBrain **टियर** को **मोड** से अलग रखता है। टियर (`compact`, `mid`, `full`) एक
प्रति-प्रोवाइडर सेटिंग है जो नियंत्रित करती है कि मॉडल कितने टूल्स देखता है — Compact
छोटे लोकल मॉडल्स के लिए उपयुक्त है, Full से hover, drag-drop, frames और shadow DOM
अनलॉक होते हैं। मोड
(`ask`, `act`, `dev`) यह नियंत्रित करता है कि उपयोगकर्ता क्या अनुमति दे रहा है।

टूल-वार-टियर पूरी मैट्रिक्स, WebMCP नोट्स और Dev-मोड डायग्नोस्टिक्स
[एजेंट टूल्स](docs/agent-tools.md) में हैं।

## स्लैश कमांड्स

पूरे सिग्नेचर और फ़्लैग्स के लिए पैनल में `/help` टाइप करें। सबसे उपयोगी:

| कमांड                                                                                  | यह क्या करता है                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/ask` · `/act` · `/dev` · `/plan`                                                     | भेजने से पहले मोड बदलें                                                     |
| `/schedule [prompt]`                                                                   | शेड्यूल्ड टास्क बनाएँ                                                        |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | मौजूदा पेज को पोल करें और शर्त पूरी होने पर कार्रवाई करें                     |
| `/workflow` · `/workflow --save <name>`                                                | सेव किए वर्कफ़्लो प्रबंधित करें या आख़िरी सफल रन को कंपाइल करें                |
| `/teach --start <name>` · `/teach --end`                                               | आपके दिखाए गए कार्यों से रीयूज़ेबल वर्कफ़्लो सीखें                             |
| `/memory --add <text>`                                                                 | उपयोगकर्ता प्राथमिकता सेव करें                                                |
| `/screenshot [--full-page]`                                                            | टैब का, या पूरी स्क्रॉल होने वाले पेज का कैप्चर लें                           |
| `/record [--transcribe]`                                                               | मौजूदा टैब रिकॉर्ड करें, वैकल्पिक रूप से ट्रांसक्रिप्ट सेव करें                |
| `/export [--traces \| --config]`                                                       | बातचीत, टूल चेन या Settings स्नैपशॉट डाउनलोड करें                            |
| `/compact` · `/reset` · `/verbose`                                                     | कॉन्टेक्स्ट संपीडित करें, बातचीत साफ़ करें, टूल विवरण टॉगल करें                |
| `/allow-api`                                                                           | प्रति-बातचीत ओवरराइड जो UI फेल होने पर `fetch_url` को बदलाव करने देता है      |

`/watch` पहली जाँच तुरंत चलाता है, फिर हर 60 सेकंड में पोल करता है
(`--secs` 30–120 स्वीकार करता है)। "जब नया commit दिखे" जैसे सापेक्ष कंडीशन
पहली जाँच पर बेसलाइन बनाते हैं; `--keep` वॉच को चालू रखता है और एक ही
स्थिर इवेंट की के लिए बार-बार अलर्ट दबाता है।

पूरा संदर्भ, `/dangerously-skip-permissions` और run-capture सफ़िक्स सहित:
[स्लैश कमांड्स](docs/slash-commands.md)।

## कीबोर्ड शॉर्टकट्स

Chrome साइड पैनल शॉर्टकट्स तब काम करते हैं जब WebBrain साइड पैनल में फोकस हो।

| शॉर्टकट                         | यह क्या करता है                                                             |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Ctrl+/` या `Cmd+/`             | इनपुट पर फोकस करें                                                           |
| `Ctrl+Shift+A` या `Cmd+Shift+A` | संदेश की शुरुआत `/ask` से करें                                              |
| `Ctrl+Shift+X` या `Cmd+Shift+X` | संदेश की शुरुआत `/act` से करें                                              |
| `Ctrl+Shift+D` या `Cmd+Shift+D` | संदेश की शुरुआत `/dev` से करें                                              |
| `Escape`                        | सक्रिय रन रोकें, बशर्ते वह सिर्फ़ स्लैश-कमांड ऑटोकम्प्लीट बंद कर रहा हो      |
| `Escape` दो बार                 | WebBrain या ब्राउज़र पेज से सक्रिय रिकॉर्डिंग रोकें                           |

## दस्तावेज़

|                                                                                                                          |                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [आर्किटेक्चर](docs/architecture.md)                                                                                      | सिस्टम ओवरव्यू, टर्न फ़्लो, सबसिस्टम्स                    |
| [एजेंट टूल्स](docs/agent-tools.md)                                                                                       | टियर्स, मोड्स और पूरी टूल मैट्रिक्स                      |
| [स्लैश कमांड्स](docs/slash-commands.md)                                                                                 | हर कमांड और फ़्लैग                                        |
| [प्रोवाइडर्स और मॉडल्स](docs/providers-and-models.md)                                                                   | सभी प्रोवाइडर कार्ड्स, लोकल सेटअप, टियर्स               |
| [Skills](docs/skills.md)                                                                                                 | बंडल्ड skills, इम्पोर्टिंग, skill टूल्स                  |
| [सिक्योरिटी मॉडल](docs/security-model.md)                                                                                | अनुमतियाँ, क्रेडेंशियल्स, ट्रस्ट बाउंड्रीज़              |
| [Cloud Bridge अनुमोदन](docs/cloud-bridge-browser-approval.md)                                                            | बैकएन्ड्स के लिए ऑप्ट-इन ब्राउज़र रजिस्ट्रेशन और अनुमोदन  |
| [प्रॉम्प्ट-इंजेक्शन डिफेंस](docs/prompt-injection-defense.md)                                                            | डिफेंस लेयर्स और ज्ञात कमियाँ                            |
| [प्राइवेसी और डेटा फ़्लो](docs/privacy-and-data-flow.md)                                                                 | ब्राउज़र से क्या बाहर जाता है, और क्या नहीं               |
| [Accessibility tree और refs](docs/accessibility-tree-and-refs.md)                                                       | पेज कैसे पढ़े और टारगेट किए जाते हैं                     |
| [साइट एडैप्टर्स](docs/site-adapters.md)                                                                                 | साइट-वार मार्गदर्शन और वर्ज़न्ड वर्कफ़्लो कॉन्ट्रैक्ट्स    |
| [एक्सपोर्ट और वर्कफ़्लो फ़ॉर्मैट्स](docs/export-and-workflow-formats.md)                                                  | `webbrain-config/1`, `webbrain-workflow/1`               |
| [टूल जोड़ें](docs/adding-a-tool.md) · [स्थानीयकरण](docs/localization.md) · [टेस्ट परिदृश्य](docs/test-scenarios.md) | कंट्रीब्यूटर गाइड्स                                      |
| [कम्युनिटी](docs/community.md)                                                                                          | Discord सर्वर गाइड: चैनल्स, रोल्स, नियम, एस्केलेशन       |

[中文](docs/zh-CN/) और [Français](docs/fr/) में भी उपलब्ध।

## कम्युनिटी

WebBrain से जुड़ा हर कुछ — मदद, लोकल और क्लाउड मॉडल सेटअप, साइट
एडैप्टर्स, show-and-tell, और कंट्रीब्यूटर समन्वय —
[WebBrain Discord](https://discord.gg/cgC325ssfw) पर चर्चा करें। सर्वर कैसे
संगठित है इसके लिए [कम्युनिटी](docs/community.md) देखें, और चैनल, रोल्स व
वेलकम-स्क्रीन कॉन्फ़िगरेशन के लिए [discord-setup](docs/discord-setup.md) देखें।
बग रिपोर्ट और फ़ीचर अनुरोध Discord नहीं, बल्कि
[GitHub issues](https://github.com/webbrain-one/webbrain/issues) में भेजें।

## रिपॉज़िटरी लेआउट

```
src/chrome/     Manifest V3 build — service worker, chrome.scripting, sidePanel
src/firefox/    Manifest V2 build — background page, executeScript, sidebar_action
docs/           Design and reference docs (en, zh-CN, fr)
mcp-server/     MCP server — delegate browser tasks from Claude Code, Codex, Cursor
lmstudio-plugin/  Web tools + browser delegation as a standalone LM Studio plugin
web/            Landing site and docs site
test/           Node test suite, LLM scenario benchmarks, security corpora
```

एजेंट का लगभग सारा कोड दोनों builds में साझा है। वे कहाँ
अलग होते हैं, इसके लिए [आर्किटेक्चर](docs/architecture.md#chrome-vs-firefox-key-differences) देखें।

## ज्ञात समस्याएँ

**Firefox, Chrome से काफ़ी कमज़ोर है।** Firefox में `chrome.debugger` के ज़रिए Chrome
DevTools Protocol का कोई समकक्ष नहीं है, इसलिए Firefox build में कोई shadow-DOM
piercing नहीं, कोई सच्चे trusted mouse events नहीं (कुछ React/Vue हैंडलर्स फ़ायर
नहीं होंगे), कोई closed-shadow-root traversal नहीं, कोई `resolveSelector` retry
budget नहीं, कोई SPA-navigation-aware retry नहीं, और कोई CDP स्क्रीनशॉट नहीं।
यह विूपोर्ट स्क्रीनशॉट्स के लिए — निष्क्रिय run टैब्स सहित — `tabs.captureTab`
उपयोग करता है, पर Chrome के पिक्सल-परफेक्ट या फुल-पेज CDP कैप्चर नहीं दे सकता।
साइट एडैप्टर्स, विज़न डिटेक्शन, लूप डिटेक्शन, ऑटो-स्क्रीनशॉट लूप और Compact
प्रॉम्प्ट/टूल सेट _वाक़ई_ Firefox पर मिरर किए गए हैं। कुछ सिंगल-पेज ऐप्स में
क्लाइन्ट-साइड नेविगेशन के बाद content-script का दोबारा इंजेक्ट होना भी फेल हो
सकता है।

## कंट्रीब्यूट करें

देखें [CONTRIBUTING.md](CONTRIBUTING.md)। टूल जोड़ने के लिए
[टूल जोड़ें](docs/adding-a-tool.md) की चेकलिस्ट फ़ॉलो करें। प्रोवाइडर जोड़ने के लिए
`BaseLLMProvider` को subclass करें, `chat()` (और वैकल्पिक रूप से `chatStream()`)
इम्प्लीमेंट करें, और उसे `providers/manager.js` में रजिस्टर करें —
`src/chrome/` और `src/firefox/` दोनों में बदलाव मिरर करें। सभी प्रोवाइडर्स
`{ content, toolCalls, usage }` में नॉर्मलाइज़ होते हैं; विवरण
[प्रोवाइडर्स और मॉडल्स](docs/providers-and-models.md#adding-a-provider) में।

हाल के बदलाव [CHANGELOG.md](CHANGELOG.md) में हैं।

## MCP सर्वर

किसी कोडिंग एजेंट को *आपका* ब्राउज़र इस्तेमाल करने दें। Claude Code, Codex, Cursor
और OpenClaw किसी कार्य को उस सेशन में चल रहे WebBrain को सौंप सकते हैं जिसमें आप
पहले से साइन इन हैं — cookies मौजूद, SSO पहले ही पार। एक हेडलेस फ़्रेमवर्क
लॉग-आउट अवस्था में शुरू होता है और पहले लॉगिन वॉल पर अटक जाता है; यह नहीं अटकाता।

```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

Claude Code MCP सेशन शुरू करते समय सर्वर अपने आप लॉन्च कर देता है।
इसे स्वयं लॉन्च करने के लिए, निम्नलिखित कमांड चलाएँ और उस टर्मिनल को खुला छोड़ दें
(रोकने के लिए `Ctrl+C` दबाएँ):

```bash
npx -y @webbrain/mcp-server
```

सर्वर चलने के बाद, **WebBrain → Settings → Bridge** खोलें,
URL को `ws://127.0.0.1:17374/extension` पर सेट करें, `npx -y
@webbrain/mcp-server pairing-key` द्वारा छपा गया पेयरिंग key **Pairing key** में
पेस्ट करें, और उसे सक्षम करें।
सर्वर उसी सॉकेट पर भरोसा करता है जो साबित करे कि उसके पास वह key है (एक fresh
challenge पर HMAC; key कभी भेजी नहीं जाती), इसलिए कोई अन्य लोकल प्रोसेस एक्सटेंशन
बनकर पेश नहीं आ सकता। LM Studio plugin उसी key फ़ाइल का उपयोग करता है,
`~/.webbrain/bridge-key`. सर्वर अपग्रेड करने से पहले एक्सटेंशन अपडेट करें: जिस
वर्ज़न में Pairing key फ़ील्ड नहीं है, वह पेयर नहीं हो सकता।
Chromium ब्राउज़र्स पर bridge एक्सटेंशन के off-screen दस्तावेज़ से चलता है।
Firefox इसे बैकग्राउंड पेज में होस्ट करता है और उसी **Settings → Bridge** टैब के
अंतर्गत कॉन्फ़िगर होता है (असली Firefox इंस्टॉल पर MCP सर्वर के साथ अभी सत्यापित
नहीं हुआ)। एक बैकएन्ड जिसे कमांड भेजने से पहले हर ब्राउज़र को मंज़ूर देना होता है,
वह [Cloud Bridge ब्राउज़र अनुमोदन](docs/cloud-bridge-browser-approval.md) में वर्णित
ऑप्ट-इन टोकन हैंडशेक इस्तेमाल कर सकता है।

यदि Settings में **Connection error: WebSocket error** दिखे, तो कॉन्फ़िगर किए गए
URL पर आम तौर पर कोई सुन रहा (listen) नहीं होता। MCP सर्वर शुरू करें, पुष्टि करें
कि URL पोर्ट `17374` उपयोग करता है, और उसकी प्रोसेस चलती रहने दें। देखें
[`mcp-server` ट्रबलशूटिंग गाइड](mcp-server/README.md#troubleshooting) — लिस्टनर
जाँच और अन्य bridge पोर्ट्स के लिए।

```
webbrain_run(task: "open the Stripe dashboard and list last week's failed
             payments with amounts and customer emails", mode: "ask")
```

जब कॉलर को गद्य सारांश के बजाय पूर्वानुमानित संरचित आउटपुट चाहिए, तब JSON Schema
के साथ `webbrain_extract` उपयोग करें। सर्वर छह टास्क-स्तर के टूल्स देता है: run,
संरचित निष्कर्षण (extraction), status, clarification response, abort और
connection diagnostics.

`mode='ask'` रीड-ओनली है। `mode='act'` क्लिक और टाइप कर सकता है, वही इन-ब्राउज़र
अनुमोदन प्रॉम्प्ट्स के साथ जो एक इंसान को मिलते हैं। सर्वर लगभग 50 निम्न-स्तरीय
ब्राउज़र प्रिमिटिव्स नहीं, बल्कि टास्क डीलिगेशन देता है: WebBrain का अनुमति गेट
एजेंट लूप में रहता है, इसलिए सॉकेट पर प्रति-प्रिमिटिव एक्सेस गेट के नीचे बैठकर उसे
बायपास कर देगी। विवरण [`mcp-server/`](mcp-server/) में।

पूरा क्लाइंट सेटअप, टूल आर्ग्युमेंट्स, run लाइफ़साइकल, संरचित-आउटपुट
उदाहरण, सुरक्षा सीमाएँ और ट्रबलशूटिंग गाइड
[`web/docs/mcp/`](web/docs/mcp/) पर हैं।

> एक्सटेंशन एक समय में **एक** bridge सॉकेट थामे रखता है — WebBrain Cloud (17373),
> MCP सर्वर (17374), या LM Studio plugin (17375)। **Settings → Bridge** में URL
> बदलकर स्विच करें।

## LM Studio plugin

एक स्टैंडअलोन [LM Studio](https://lmstudio.ai) plugin
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools) पर:

```bash
lms clone webbrain/web-tools
```

`fetch_url` और `research_url` शुद्ध Node HTTP हैं — ब्राउज़र की ज़रूरत नहीं, पर
साथ ही कोई cookies नहीं, कोई सेशन नहीं और कोई JavaScript नहीं। Chromium
ब्राउज़र पर एक्सटेंशन इंस्टॉल होने पर, `browser_task` आपके असली साइन-इन किए हुए
ब्राउज़र में डीलिगेशन जोड़ता है, और उन प्रामाणिकृत (authenticated) व क्लाइन्ट-रेंडर
पेजों तक पहुँचता है जहाँ सादा HTTP नहीं पहुँच सकता। कोई एक्सटेंशन जुड़ा न हो तो यह
एक कार्रवाई-योग्य संदेश के साथ डिग्रेड हो जाता है, और HTTP टूल्स Firefox पर
काम करते रहते हैं।

स्रोत: [`lmstudio-plugin/`](lmstudio-plugin/)।


## कंट्रीब्यूटर्स

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## उद्धरण (Citation)

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: Open-source AI browser agent for chatting with pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## लाइसेंस

WebBrain [GPL-3.0-or-later](LICENSE) के अंतर्गत लाइसेंस्ड है, क्योंकि वितरित
ब्राउज़र एक्सटेंशन GPL-लाइसेंस्ड Xapian/libzim WebAssembly रनटाइम को बंडल और
इंटीग्रेट करता है।

[Emre Sokullu](https://emresokullu.com) और [ओपन-सोर्स कंट्रीब्यूटर्स](https://github.com/webbrain-one/webbrain/graphs/contributors) द्वारा ❤️ से निर्मित।
