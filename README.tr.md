<p align="center">
<img src="assets/logo-mark.png" alt="DIV logosu" width="92">
</p>

<h1 align="center">DIV</h1>

<p align="center">
Sayfalarla sohbet etmenizi, görevleri otomatikleştirmenizi ve seçtiğiniz bir LLM ile çok adımlı iş akışlarını çalıştırmanızı sağlayan, açık kaynaklı bir yapay zeka tarayıcı aracısı.
</p>

<p align="center">
<a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="DIV'i Chrome Web Mağazası'ndan yükleyin"></a>
<a href="https://addons.mozilla.org/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="DIV'i Firefox Tarayıcı Eklentileri'nden yükleyin"></a>
<a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="DIV'i Microsoft Edge Eklentileri'nden yükleyin"></a>
</p>

<p align="center">
<a href="README.md">İngilizce</a> ·
<a href="README.zh-CN.md">Çince</a> ·
<a href="README.fr.md">Fransızca</a> ·
<a href="docs/">Belgeler</a> ·
<a href="https://webbrain.one">Web Sitesi</a> ·
<a href="https://discord.gg/cgC325ssfw">Discord</a> ·
<a href="LICENSE">GPL-3.0-or-later</a>
</p>

![DIV bir sayfayı okuyor, bir formu dolduruyor ve bir dosya getiriyor](assets/webbrain-demo.gif)

DIV, bir yapay zekayı... ...sekmelerinizin yanındaki bir panelde yer alan bir aracı (agent).
Üzerinde bulunduğunuz sayfa hakkında ona sorular sorun ya da bir görev verip
sayfa içinde tıklama, yazma ve gezinme işlemlerini gerçekleştirmesine izin verin.
Araç, seçtiğiniz model üzerinde çalışır: yerel bir `llama.cpp` veya `Ollama` sunucusu,
üst düzey bir bulut API'si ya da hiçbir kurulum gerektirmeyen, yönetilen varsayılan seçenek.

## Kurulum

[Chrome Web Mağazası](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
[Firefox Eklentileri](https://addons.mozilla.org/firefox/addon/webbrain/) veya
[Edge Eklentileri](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo)
üzerinden yükleyin.

<details>
<summary><b>Veya kaynak koddan yükleyin</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome** — `chrome://extensions/` adresini açın, **Geliştirici modu**nu (sağ üstte)
etkinleştirin, **Paketlenmemiş öğe yükle**'ye tıklayın ve `webbrain/src/chrome`
klasörünü seçin. Çalışma dizinindeki gereksiz dosyaları dahil etmeyen yalıtılmış
bir kopyası için, önce `npm run build:chrome` komutunu çalıştırın ve bunun yerine
`webbrain/build/chrome` klasörünü yükleyin.

**Firefox** — `about:debugging#/runtime/this-firefox` adresini açın, **Geçici
Eklenti Yükle**'ye tıklayın ve `src/firefox/manifest.json` dosyasını (veya
`npm run build:firefox` işleminden sonra `build/firefox/manifest.json` dosyasını)
seçin. Geçici eklentiler Firefox yeniden başlatıldığında kaldırılır; kalıcı
kurulum için [addons.mozilla.org](https://addons.mozilla.org) üzerinden
imzalama işlemi gereklidir.

</details>

## Kullanım

Yan paneli açmak için DIV simgesine tıklayın ve ardından şuna benzer komutlar yazın:

- "Bu sayfayı özetle"
- "Fiyatlandırmayla ilgili tüm bağlantıları bul"
- "Arama kutusuna 'AI agents' yaz ve Ara'ya tıkla"
- "github.com'a git ve popüler depoları bul"

Üç farklı mod, aracının (agent) yapabileceklerini belirler:

| Mod     | Yapabilecekleri                                                        |
| ------- | ---------------------------------------------------------------------- |
| **Ask** | Salt okunur. Sayfayı okur, soruları yanıtlar, URL'leri getirir. |
| **Act** | Tıklar, yazar, gezinir, yükler, indirir, formları doldurur. |
| **Act** | Sayfa kaynağı, stiller, konsol, ağ ve geri alınabilir sayfa düzenlemeleri ekler. |

## Bir model seçin

**DIV Compass 1.0** varsayılan modeldir; herhangi bir API anahtarı veya yerel kurulum gerektirmez.

**Yerel modeller** de API anahtarı gerektirmez. DIV'i OpenAI uyumlu herhangi bir
sunucuya yönlendirmeniz yeterlidir:

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Osaurus (`:1337/v1`), Jan (`:1337/v1`), LocalAI (`:8080/v1`) ve GPT4All
(`:4891/v1`) aynı şekilde çalışır. Genel bir **Yerel OpenAI uyumlu Proxy** kartı,
CLIProxyAPI gibi kimlik doğrulamalı geri döngü (loopback) ağ geçitlerini de destekler;
[güvenli abonelik proxy kurulumu](docs/providers-and-models.md#subscription-proxy-example-cliproxyapi) bölümüne bakın. **Unsloth Studio (Yerel)**, kullanıcı tarafından yapılandırılan Studio portu ve `sk-unsloth-` API anahtarı ile OpenAI uyumlu yolu kullanır; bkz.
[Unsloth Studio kurulumu](docs/providers-and-models.md#unsloth-studio).
**Osaurus (Yerel)**; model keşfi, akış (streaming) ve araç çağrıları (tool calls) özellikleri aracılığıyla Mac üzerindeki Osaurus sunucusuna bağlanır; bkz.
[Osaurus kurulumu](docs/providers-and-models.md#osaurus).
Yüklü modelin bağlam penceresini seçilen seviyenin sistem istemi ve araç şemaları,
sayfa ve konuşma geçmişi ile istenen çıktı için boyutlandırın. **16k bir varsayılan
ayar değeridir, yeterli olacağı garanti edilen bir alt sınır değildir; Compact
seviyesinin 8k'ya sığacağı da garanti edilmez.** Mid ve Full, geçmiş birikmeden
bile 16k'yı aşabilir; sıkıştırma sabit istem ve şemaları küçültemez. Boyut
tahmini modelin gerçek tokenizer hesabı değildir; bkz.
[bağlam rehberi](docs/providers-and-models.md#local-providers).
DIV; llama.cpp, Ollama ve LM Studio için ilgili pencereyi otomatik olarak algılar
ve alan doldukça konuşma içeriğini otomatik olarak sıkıştırır. Ollama,
llama.cpp, LM Studio ve LocalAI için, ekran görüntüleri eklenmeden önce
sunucuya özgü meta verileri de okur; Ayarlar bölümü Otomatik, Zorunlu Açık ve Kapalı
seçenekleri sunar. İsteğe bağlı Model alanı boş bırakıldığında,
yüklü modelin durumu her kullanıcı etkileşiminde yeniden kontrol edilir;
böylece sunucu tarafındaki anlık model değişimi (hot swap) geçerli olur. Ayrıca
`ollama launch webbrain --model <model>` şeklinde bir önizleme başlatma
imkanı da mevcuttur. Ayrıntılar:
[sağlayıcılar ve modeller](docs/providers-and-models.md#local-providers).

**Bulut API'leri** — OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter ve daha fazlası.
Ayarlar; test edilmiş LFM2.5 2.6B ön ayarını kullanan, uç nokta (endpoint) gerektirmeyen
yerel WebGPU seçeneği ve deneysel özel Hugging Face ONNX deposu seçeneği dahil olmak üzere
Chromium'da **112 yerleşik sağlayıcı kartı** (Firefox'ta 111) ile gelir;
[tam kataloğa](docs/providers-and-models.md#extended-provider-catalog) bakınız.

Yerel veya kendi sağladığınız (BYO) bir sağlayıcı için, sağlayıcı bazlı
**Araştırma amacıyla sorguları paylaş** anahtarı varsayılan olarak kapalıdır.
Bu özellik etkinleştirildiğinde, mevcut temizlenmiş istem/yanıt paylaşımına ek olarak,
ilgili sağlayıcının model denemelerine (başarısız olanlar dahil) dair
sınırlandırılmış ve içerik barındırmayan bir tanılama zaman çizelgesi paylaşılır.
Zaman çizelgesi; araç adlarını, sonuçları, hata kodlarını ve süreleri içerir;
ancak araç argümanlarını, sayfa içeriğini veya ekran görüntülerini içermez.
Normal bir üretim (generation) paylaşımı gerçekleşmeden önce bir işlem başarısız olursa,
sınırlandırılmış model isteği ve süreci durduran nihai hata bilgisi
tanılama kaydına dahil edilir. İkinci bir paylaşım anahtarına gerek yoktur; mevcut anahtarın kapatılması, kuyruğa alınmış tanılama verilerini de temizler.

## Özellikler

- **Her türlü sayfayı okur** — Kırılgan seçiciler (selectors) yerine erişilebilirlik ağacı (accessibility tree) aracılığıyla metin, bağlantı, form, tablo, PDF ve etkileşimli öğeleri okur.
- **İşlem yapar** — Tıklama, yazma, kaydırma, gezinme, yükleme, indirme ve form doğrulama gibi işlemleri gerçekleştirir; kritik eylemlerden önce site bazlı izin istemleri sunar.
- **Eylemden önce planlama** — Herhangi bir araç çalıştırılmadan önce, yapılandırılmış bir plan oluşturulabilir, onay için görüntülenebilir ve onaylanan plan çalışma alanına (scratchpad) sabitlenebilir.
- **Çok adımlı ajan** — 195 adıma kadar yapılandırılabilen (varsayılan 130) otonom araç kullanım döngüsü; sınıra ulaşıldığında "Devam Et" butonu sunar.
- **Kaydedilmiş iş akışları** — Başarılı bir çalıştırma işlemini; yeniden çalıştırabileceğiniz, dışa aktarabileceğiniz ve paylaşabileceğiniz, yeniden kullanılabilir ve parametrelerden bağımsız bir iş akışına dönüştürün.
- **Zamanlanmış görevler ve izlemeler** — İleri bir zaman için `/schedule` komutu; sayfayı düzenli kontrol edip belirli bir koşul sağlandığında işlem yapmak için `/watch` komutu.
- **Yetenekler** — Yalnızca ilgili olduğunda yüklenen güvenilir talimatlar ve araçlar.
- **Akıllı bağlam yönetimi** — Token duyarlı otomatik sıkıştırma, araç sonucu sınırları ve acil durum taşma (overflow) kurtarma mekanizması.
- **Sekme bazlı görüşmeler** — Her sekme kendi geçmişini tutar; belirtilen tercihler için isteğe bağlı yerel kullanıcı belleği.
- **İsteğe bağlı cihazlar arası geri çağırma** — Yerel bellek varsayılan olarak kalırken, salt okunur sorgulamalar için MemCode'u OAuth ile bağlayın ([kurulum ve gizlilik](docs/memcode-recall.md)).
- **Okuma odaklı yan panel** — Akış halindeki "Ask" (Soru) yanıtları, yanıtlar uzadıkça sorunuzu görünür kılan kayan kontroller, kopyalama butonları, sayfa inceleme başlığı ve işlem sırasında çalışan durdurma butonu.
- **Varsayılan olarak deterministik** — Tarayıcı kontrol kararları için `0.15`, "Ask" (Soru) için `0.3`, görsel ekran görüntüsü açıklamaları için `0` sıcaklık (temperature) değeri.

## Ajan araçları

DIV, **katman** (tier) ile **mod** (mode) kavramlarını birbirinden ayırır. Seviye (`compact`, `mid`, `full`), bir modelin kaç araca erişebileceğini belirleyen
ve sağlayıcı bazında ayarlanan bir parametredir; `Compact` küçük yerel modeller için uygundur,
`Full` ise üzerine gelme (hover), sürükle-bırak, çerçeveler (frames) ve shadow DOM özelliklerini etkinleştirir.
Mod (`ask`, `act`, `dev`) ise kullanıcının hangi işlemlere izin verdiğini kontrol eder.

Seviyeye göre araç matrisinin tamamı, WebMCP notları ve Dev-modu tanılamaları
[agent tools](docs/agent-tools.md) dosyasında yer almaktadır.

## Eğik çizgi (Slash) komutları

Tam komut imzalarını ve bayrakları (flags) görmek için panele `/help` yazın. En yararlı olanlar şunlardır:

| Komut                                                                                  | İşlevi                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/ask` · `/act` · `/dev` · `/plan`                                                     | Gönderimden önce modu değiştirir                                            |
| `/schedule [prompt]`                                                                   | Zamanlanmış bir görev oluşturur                                             |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | Mevcut sayfayı izler ve bir koşul sağlandığında işlem yapar                   |
| `/workflow` · `/workflow --save <name>`                                                | Kaydedilmiş iş akışlarını yönetir veya son başarılı olanı derlerbaşarılı çalıştırma                   |
| `/teach --start <name>` · `/teach --end`                                               | Gösterdiğiniz eylemlerden yeniden kullanılabilir bir iş akışı öğrenin                    |
| `/memory --add <text>`                                                                 | Bir kullanıcı tercihini kaydedin                                                      |
| `/screenshot [--full-page]`                                                            | Sekmeyi veya kaydırılabilir sayfanın tamamını yakalayın                                |
| `/record [--transcribe]`                                                               | Mevcut sekmeyi kaydedin; isteğe bağlı olarak dökümünü (transkript) saklayın                      |
| `/export [--traces \| --config]`                                                       | Sohbeti, araç zincirini veya Ayarlar anlık görüntüsünü indirin               |
| `/compact` · `/reset` · `/verbose`                                                     | Bağlamı sıkıştırın, sohbeti temizleyin, araç ayrıntılarını açıp kapatın                 |
| `/allow-api`                                                                           | Arayüz (UI) hata verdiğinde `fetch_url` işleminin durumu değiştirmesine izin veren, sohbet bazlı geçersiz kılma |

`/watch` komutu ilk kontrolü hemen yapar, ardından her 60 saniyede bir tekrar kontrol eder
(`--secs` parametresi 30–120 arası değerleri kabul eder). "Yeni bir commit (işleme) göründüğünde" gibi göreceli koşullar,
ilk kontrolde bir temel durum (baseline) oluşturur; `--keep` izleme işlemini sürdürür ve
aynı kararlı olay anahtarı için tekrarlanan uyarıları bastırır.

`/dangerously-skip-permissions` ve çalıştırma-yakalama (run-capture)
sonekleri dahil olmak üzere tam referans: [slash komutları](docs/slash-commands.md).

## Klavye Kısayolları

Chrome yan panel kısayolları, DIV yan paneli odaklanmış durumdayken çalışır.

| Kısayol                         | İşlevi                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Ctrl+/` veya `Cmd+/`           | Giriş alanına odaklan                                                        |
| `Ctrl+Shift+A` veya `Cmd+Shift+A` | Ask (Sor) moduna geç                                                         |
| `Ctrl+Shift+X` veya `Cmd+Shift+X` | Act (Eylem) moduna geç                                                       |
| `Ctrl+Shift+D` veya `Cmd+Shift+D` | Dev (Geliştirme) moduna geç                                                  |
| `Escape`                        | Yalnızca slash komutu otomatik tamamlama listesini kapatmıyorsa, aktif çalıştırmayı durdur |
| `Escape` (iki kez)              | DIV veya tarayıcı sayfalarındaki aktif kaydı durdur                     |

## Dokümantasyon

| | |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [Mimari](docs/architecture.md)                                                                                           | Sistem genel bakışı, işlem akışı, alt sistemler          |
| [Ajan araçları](docs/agent-tools.md)                                                                                     | Katmanlar, modlar ve tam araç matrisi                    |
| [Eğik çizgi komutları](docs/slash-commands.md)                                                                           | Tüm komutlar ve parametreler                             |
| [Sağlayıcılar ve modeller](docs/providers-and-models.md)                                                                  | Tüm sağlayıcı kartları, yerel kurulum, katmanlar         |
| [Yetenekler](docs/skills.md)                                                                                             | Dahili yetenekler, içe aktarma, yetenek araçları         |
| [Güvenlik modeli](docs/security-model.md)                                                                                | İzinler, kimlik bilgileri, güven sınırları               |
| [Cloud Bridge onayı](docs/cloud-bridge-browser-approval.md)                                                               | Tarayıcı kaydı ve arka uçlar için onay süreci            |
| [Prompt enjeksiyonuna karşı savunma](docs/prompt-injection-defense.md)                                                    | Savunma katmanları ve bilinen açıklar                    |
| [Gizlilik ve veri akışı](docs/privacy-and-data-flow.md)                                                                   | Tarayıcıdan çıkan ve çıkmayan veriler                    |
| [Erişilebilirlik ağacı ve referanslar](docs/accessibility-tree-and-refs.md)                                               | Sayfaların okunma ve hedeflenme biçimi                   |
| [Site bağdaştırıcıları](docs/site-adapters.md)| Site bazlı rehberlik ve sürümlü iş akışı sözleşmeleri       |
| [Dışa aktarma ve iş akışı formatları](docs/export-and-workflow-formats.md)                                                       | `webbrain-config/1`, `webbrain-workflow/1`               |
| [Araç ekleme](docs/adding-a-tool.md) · [Yerelleştirme](docs/localization.md) · [Test senaryoları](docs/test-scenarios.md) | Katkıda bulunanlar için rehberler                                       |
| [Topluluk](docs/community.md)                                                                                           | Discord sunucusu rehberi: kanallar, roller, kurallar, sorun tırmandırma |

Ayrıca [中文](docs/zh-CN/) ve [Français](docs/fr/) dillerinde de mevcuttur.

## Topluluk

DIV ile ilgili her konuda —yardım, yerel ve bulut model kurulumları, site
adaptörleri, paylaşımlar ve katkıda bulunanların koordinasyonu—
[DIV Discord](https://discord.gg/cgC325ssfw) sunucusunda sohbet edin.
Sunucu yapısı için [topluluk](docs/community.md) sayfasına; kanal, rol ve
karşılama ekranı yapılandırması içinse [discord-setup](docs/discord-setup.md)
sayfasına bakın. Hata bildirimleri ve özellik istekleri Discord'da değil,
[GitHub issues](https://github.com/webbrain-one/webbrain/issues) kısmında
yapılmalıdır.

## Depo yapısı

```
src/chrome/     Manifest V3 derlemesi — service worker, chrome.scripting, sidePanel
src/firefox/    Manifest V2 derlemesi — background page, executeScript, sidebar_action
docs/           Tasarım ve referans belgeleri (en, zh-CN, fr)
mcp-server/     MCP sunucusu — Claude Code, Codex ve Cursor'dan tarayıcı görevlerini devralma
lmstudio-plugin/  Bağımsız LM Studio eklentisi olarak web araçları + tarayıcı görevlerini devralma
web/            Tanıtım sitesi ve dokümantasyon sitesi
test/           Node test paketi, LLM senaryo kıyaslamaları, güvenlik veri setleri
```

Ajan kodunun neredeyse tamamı her iki derleme arasında ortaktır.
Farklılaştıkları noktalar için [mimari](docs/architecture.md#chrome-vs-firefox-key-differences)
bölümüne bakın.

## Bilinen sorunlar

**Firefox, Chrome'a ​​kıyasla belirgin şekilde daha zayıf özelliklere sahip.** Firefox'ta `chrome.debugger` aracılığıyla sunulan Chrome DevTools Protokolü'nün (CDP) bir karşılığı bulunmamaktadır; bu nedenle Firefox sürümünde shadow-DOM'a erişim (piercing), gerçek güvenilir fare olayları (bazı React/Vue işleyicileri tetiklenmeyebilir), kapalı shadow-root (closed-shadow-root) içinde gezinme, `resolveSelector` yeniden deneme bütçesi, SPA gezinmesi farkındalıklı yeniden deneme ve CDP ekran görüntüleri gibi özellikler mevcut değildir. Görünüm alanı (viewport) ekran görüntüleri için —etkin olmayan sekmeler dahil— `tabs.captureTab` kullanılır; ancak bu yöntem, Chrome'un sunduğu piksel hassasiyetindeki veya tam sayfa CDP yakalama kalitesini sağlayamaz. Site bağdaştırıcıları (adapters), görsel algılama, döngü algılama, otomatik ekran görüntüsü döngüsü ve Kompakt istem/araç seti Firefox'a da aynen aktarılmıştır. Ayrıca bazı tek sayfalık uygulamalarda (SPA), istemci tarafındaki gezinme sonrasında içerik betiğinin (content-script) yeniden enjekte edilmesi başarısız olabilir.

## Katkıda bulunma

[CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın. Bir araç eklemek için [adding a tool](docs/adding-a-tool.md) bölümündeki kontrol listesini izleyin. Bir sağlayıcı (provider) eklemek için `BaseLLMProvider` sınıfından türetme yapın, `chat()` (ve isteğe bağlı olarak `chatStream()`) metodunu uygulayın ve bunu `providers/manager.js` içinde kaydedin; bu değişiklikleri hem `src/chrome/` hem de `src/firefox/` dizinlerine yansıtmayı unutmayın. Tüm sağlayıcılar `{ content, toolCalls, usage }` yapısına göre normalleştirilir; ayrıntılar için [providers and models](docs/providers-and-models.md#adding-a-provider) bölümüne bakabilirsiniz.

Yakın zamandaki değişiklikler [CHANGELOG.md](CHANGELOG.md) dosyasında yer almaktadır.

## MCP sunucusu

Bir kodlama aracısının *sizin* tarayıcınızı kullanmasını sağlayın. Claude Code, Codex, Cursor ve OpenClaw; halihazırda oturum açmış olduğunuz (çerezlerin mevcut olduğu ve SSO işlemlerinin tamamlandığı) bir oturumda çalışan DIV'e görev devredebilir. Başsız (headless) bir çerçeve (framework) oturum kapalı şekilde başlar ve ilk giriş engelinde takılır; bu sistemde ise böyle bir sorun yaşanmaz. ```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

Claude Code, bir MCP oturumu başlattığında sunucuyu otomatik olarak çalıştırır.
Bunun yerine sunucuyu kendiniz başlatmak isterseniz, aşağıdaki komutu çalıştırın ve ilgili terminali
açık bırakın (durdurmak için `Ctrl+C` tuşlarına basın):

```bash
npx -y @webbrain/mcp-server
```

Sunucu çalışmaya başladıktan sonra **DIV → Settings → Bridge** (Ayarlar → Köprü) kısmını açın,
URL'yi `ws://127.0.0.1:17374/extension` olarak ayarlayın ve özelliği etkinleştirin.
Chromium tabanlı tarayıcılarda köprü, uzantının ekran dışı belgesi (off-screen document) üzerinden çalışır.
Firefox ise bunu arka plan sayfasında barındırır ve yapılandırma yine aynı
**Settings → Bridge** sekmesi altından yapılır (gerçek bir Firefox kurulumunda
MCP sunucusu ile henüz doğrulanmamıştır). Komut göndermeden önce her bir tarayıcıyı
onaylaması gereken bir arka uç (backend), [Cloud Bridge tarayıcı onayı](docs/cloud-bridge-browser-approval.md)
bölümünde açıklanan "opt-in" (kullanıcı onaylı) token el sıkışma yöntemini kullanabilir.

Ayarlar kısmında **Connection error: WebSocket error** (Bağlantı hatası: WebSocket hatası)
uyarısı alıyorsanız, yapılandırılan URL'yi dinleyen bir süreç (listener) yok demektir.
MCP sunucusunu başlatın, URL'nin `17374` numaralı portu kullandığından emin olun
ve sunucu sürecini çalışır durumda bırakın. Dinleyici kontrolü ve diğer köprü portları
hakkında bilgi için [`mcp-server` sorun giderme kılavuzuna](mcp-server/README.md#troubleshooting) bakın.

```
webbrain_run(task: "Stripe panosunu aç ve geçen haftaki başarısız
ödemeleri tutarları ve müşteri e-postalarıyla birlikte listele", mode: "ask")
```

Çağıran tarafın düz metin bir özet yerine öngörülebilir ve yapılandırılmış bir çıktıya
ihtiyaç duyduğu durumlarda, JSON Şeması (JSON Schema) ile birlikte `webbrain_extract` kullanın.r, görev düzeyinde altı araç sunar: çalıştırma (run), yapılandırılmış veri çıkarma (structured extraction), durum (status), açıklama talebine yanıt (clarification response), iptal (abort) ve bağlantı tanılaması (connection diagnostics).

`mode='ask'` modu salt okunurdur. `mode='act'` modu ise tıklama ve yazma işlemlerini gerçekleştirebilir; ancak bu işlemler, bir insanın karşılaştığı tarayıcı içi onay istemlerine tabidir. Sunucu, yaklaşık 50 adet düşük seviyeli tarayıcı ilkel komutu (primitive) yerine görev devretme (delegation) yeteneği sunar; DIV'in izin denetim mekanizması (permission gate) ajan döngüsü içinde yer aldığından, bir soket üzerinden doğrudan ilkel komut erişimi sağlamak bu denetim mekanizmasının altında kalır ve onu devre dışı bırakırdı. Ayrıntılar [`mcp-server/`](mcp-server/) dizinindedir.

Eksiksiz istemci kurulumu, araç argümanları, çalıştırma yaşam döngüsü, yapılandırılmış çıktı örnekleri, güvenlik sınırları ve sorun giderme kılavuzu [`web/docs/mcp/`](web/docs/mcp/) adresinde yer almaktadır.

> Uzantı, aynı anda **tek bir** köprü soketi (bridge socket) tutar: DIV Cloud (17373),
> MCP sunucusu (17374) veya LM Studio eklentisi (17375). **Ayarlar → Köprü (Settings → Bridge)**
> altındaki URL'yi değiştirerek geçiş yapabilirsiniz.

## LM Studio eklentisi

[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools) adresinde bulunan bağımsız bir
[LM Studio](https://lmstudio.ai) eklentisi:

```bash
lms clone webbrain/web-tools
```

`fetch_url` ve `research_url` saf Node HTTP kullanır; tarayıcı gerektirmezler ancak çerez, oturum veya JavaScript desteği de sunmazlar. Bir Chromium tarayıcısında uzantı yüklüyken, `browser_task` işlemi gerçek ve oturum açılmış tarayıcınıza bir görev devri ekler; böylece standart HTTP'nin erişemediği, kimlik doğrulaması gerektiren ve istemci tarafında oluşturulan (client-rendered) sayfalara ulaşılabilir. Uzantı bağlı olmadığında işlem yapılabilir bir mesajla geri bildirim verilir ve HTTP araçları Firefox üzerinde çalışmaya devam eder.

Kaynak: [`lmstudio-plugin/`](lmstudio-plugin/). ## Katkıda Bulunanlar

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
<img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## Atıf

```bibtex
@software{webbrain2026,
author = {Sokullu, Emre},
title = {DIV: Web sayfalarıyla sohbet etmeye olanak tanıyan açık kaynaklı yapay zeka tarayıcı aracısı},
year = {2026},
publisher = {GitHub},
url = {https://github.com/webbrain-one/webbrain}
}
```

## Lisans

DIV, [GPL-3.0-or-later](LICENSE) lisansı altındadır;
çünkü dağıtılan tarayıcı uzantısı, GPL lisanslı Xapian/libzim WebAssembly çalışma zamanını
bünyesinde barındırır ve entegre eder.

[Emre Sokullu](https://emresokullu.com) ve [açık kaynak katkıcıları](https://github.com/webbrain-one/webbrain/graphs/contributors) tarafından ❤️ ile geliştirilmiştir.
