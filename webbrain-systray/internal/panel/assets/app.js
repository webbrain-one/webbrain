"use strict";
(() => {
  // The tray opens /companion/#k=<panel key>&view=<view>; keep the key for
  // this window only.
  const hash = new URLSearchParams(location.hash.slice(1));
  let key = hash.get("k") || "";
  try {
    if (key) sessionStorage.setItem("wbc-key", key);
    else key = sessionStorage.getItem("wbc-key") || "";
  } catch (_) {}
  const startView = hash.get("view") || "";
  if (location.hash) history.replaceState(null, "", location.pathname);

  const I18N = {
    en: {
      running: "Running",
      stopped: "Not running",
      reconnecting: "Reconnecting…",
      thisComputer: "This computer",
      otherDevices: "Other devices",
      apiKey: "API key",
      copy: "Copy",
      copied: "Copied",
      show: "Show",
      hide: "Hide",
      noKey: "No API key needed on this computer. If an app asks for one, type anything.",
      firstRun: "In WebBrain, open Providers, choose Local OpenAI-compatible Proxy and paste this address. When it asks for an API key, type anything.",
      gotIt: "Got it",
      networkNote: "Other devices connect with the API key. Anyone on this network who has it can use your subscriptions.",
      noNetworkAddr: "No network address found. Is this computer on a network?",
      subs: "Subscriptions",
      add: "Add",
      addFirst: "Add a subscription",
      emptySubs: "Sign in with Claude, ChatGPT, Google, Grok or Kimi. Each one shows up here with how much of it is left.",
      resetsIn: "Resets in {d}",
      emptyUntil: "Empty until {when}",
      paused: "Paused",
      reading: "Reading usage…",
      noQuotaShort: "Usage not reported",
      noQuota: "This service does not report usage.",
      quotaErrorShort: "Usage unavailable",
      quotaError: "Usage unavailable: {msg}",
      w5h: "5 hours", wday: "Day", wweek: "Week", wmonth: "Month",
      fivehour: "5-hour limit", daily: "Daily limit", weekly: "Weekly limit", monthly: "Monthly limit",
      updated: "Updated {ago}",
      refreshUsage: "Refresh",
      refreshing: "Refreshing…",
      pause: "Pause",
      resume: "Resume",
      pausedNote: "Paused. WebBrain won't use this login until you resume it.",
      remove: "Remove",
      removeConfirm: "Remove {name}? You can sign in again later.",
      keep: "Keep",
      close: "Close",
      models: "Local models",
      d1Name: "d1 decision model",
      compassName: "Compass VLD v6 2B decision model",
      modelShortCompass: "Compass VLD v6 2B",
      modelShortD1: "d1",
      decisionModel: "Model",
      useModel: "Use {name} instead",
      deleteOther: "Delete {name} files ({size})",
      deleteOtherConfirm: "Delete {size} of {name} files?",
      runningAs: "Running as {id}",
      installedSize: "Installed, {size}",
      downloadSize: "{size} download",
      maySlow: "May run slowly on this machine",
      starting: "Loading into memory…",
      stopping: "Stopping…",
      loading: "Loading…",
      ready: "Ready",
      readyServed: "Ready, {n} decisions served",
      notSupported: "Not available for this platform yet",
      install: "Install",
      cancel: "Cancel",
      start: "Start",
      stop: "Stop",
      load: "Load",
      unload: "Unload",
      retry: "Try again",
      showLog: "Show log",
      ofSize: "{done} of {total}",
      eta: "{left} left",
      localLede: "Runs on this machine and appears to WebBrain as {id}.",
      thisMachine: "This machine",
      format: "Format",
      runtime: "Runtime",
      vision: "Images",
      context: "Context",
      onDisk: "On disk",
      download: "Download",
      visionGpu: "On",
      visionCpu: "On, CPU",
      visionOff: "Off",
      visionBuiltin: "On",
      whyBuiltin: "The MLX pack includes its vision tower.",
      whyGpu: "{need} of {budget} GPU memory leaves room for the projector.",
      whyCpu: "GPU memory is tight, so images are encoded on the CPU.",
      whyOff: "Not enough memory left for the vision projector.",
      whyForced: "Set by you below.",
      tokens: "{n} tokens",
      layers: "{n} of 64 layers on the GPU",
      warnFit: "Needs about {need}; this machine offers {budget}. It may run slowly or not at all.",
      warnPartial: "Only {n} of 64 layers fit in GPU memory; the rest run on the CPU and will be slower.",
      warnCpu: "No supported GPU was found, so it runs on the CPU. Expect a few tokens per second.",
      warnMlx: "MLX needs a Mac with Apple Silicon.",
      formatGGUF: "GGUF", formatMLX: "MLX",
      ggufNote: "llama.cpp (PrismML build), PTQ1_0 with Q8_0 vision projector",
      mlxNote: "MLX 2-bit pack with mlx-vlm",
      options: "Options",
      auto: "Auto", gpu: "GPU", cpu: "CPU", off: "Off",
      startWith: "Start with the companion",
      removeFiles: "Delete downloaded files",
      removeFilesConfirm: "Delete {size} of model files?",
      delete: "Delete",
      decisionLede: "WebBrain's decision model answers yes/no, choice and score questions about a page, here instead of in the browser.",
      endpoint: "Endpoint",
      served: "Served",
      servedValue: "{n} decisions, last in {ms} ms",
      license: "License",
      test: "Run a test decision",
      testing: "Deciding…",
      testResult: "Answer {choice} with {p}% confidence in {ms} ms.",
      settings: "Settings",
      startLogin: "Start at login",
      language: "Language",
      networkToggle: "Allow other devices on this network",
      networkHelp: "Listens on 0.0.0.0 instead of 127.0.0.1. Other devices connect with the API key; your system may ask you to allow incoming connections.",
      newKey: "Make a new API key",
      newKeyConfirm: "Other devices stop working until they get the new key.",
      connection: "Connection",
      port: "Port",
      apply: "Apply",
      portChanged: "The companion moved to port {port}. Reopen the panel from the tray icon.",
      otherFormats: "Anthropic, Gemini",
      modelsLabel: "Models",
      modelsCount: "{n} available",
      modelsNone: "None yet",
      showList: "Show",
      hideList: "Hide",
      logFile: "Show log file",
      version: "Version {v}",
      updates: "Updates",
      updAuto: "Install updates automatically",
      updAutoHelp: "New versions download in the background and install after 10 minutes without use. The companion then restarts by itself.",
      updCheck: "Check for updates",
      updChecking: "Checking for updates…",
      updCurrent: "You have the newest version.",
      updAvailable: "Version {v} is available.",
      updDownloading: "Downloading version {v}…",
      updReady: "Version {v} is ready to install.",
      updInstalling: "Installing version {v}…",
      updInstall: "Update to {v} now",
      updFailed: "The update didn't finish: {e}",
      updPage: "Download page",
      quit: "Quit WebBrain Companion",
      quitConfirm: "WebBrain loses access to your subscriptions until you open the companion again.",
      trayHidden: "macOS is hiding the WebBrain Companion icon because the menu bar is full. You can always come back here by opening WebBrain Companion again. To make room, hide menu bar icons you don't use in System Settings, Menu Bar.",
      translocated: "WebBrain Companion is running from a temporary copy that macOS made because the app wasn't moved to Applications. Quit it, move it to your Applications folder and open it from there; starting at login needs that.",
      pickTitle: "Add a subscription",
      pickSub: "You sign in on the provider's own page. The companion stores the login on this computer only.",
      more: "More services",
      browserFlow: "Sign in in your browser",
      deviceFlow: "Enter a code",
      waitTitle: "Finish signing in to {name}",
      waitBrowser: "A sign-in page opened in your browser. Approve access there and this panel updates by itself.",
      waitDevice: "Open the page below and enter this code:",
      openPage: "Open the sign-in page",
      openAgain: "Open the page again",
      copyCode: "Copy code",
      waiting: "Waiting for {name}…",
      noReturn: "The browser shows an error after you approve?",
      pasteHelp: "Copy the full address from the browser's address bar and paste it here.",
      pastePh: "http://localhost:…",
      submit: "Finish sign-in",
      doneTitle: "{name} is connected",
      doneSub: "Its models are now on your endpoint. Usage appears in a moment.",
      done: "Done",
      failTitle: "Sign-in didn't finish",
      tokenMissing: "Open this panel from the WebBrain Companion icon in your menu bar or system tray.",
      ago_now: "just now", ago_m: "{n} min ago", ago_h: "{n} h ago",
      phase_installing: "Installing",
    },
    tr: {
      running: "Çalışıyor",
      stopped: "Çalışmıyor",
      reconnecting: "Yeniden bağlanıyor…",
      thisComputer: "Bu bilgisayar",
      otherDevices: "Diğer cihazlar",
      apiKey: "API anahtarı",
      copy: "Kopyala",
      copied: "Kopyalandı",
      show: "Göster",
      hide: "Gizle",
      noKey: "Bu bilgisayarda API anahtarı gerekmez. Bir uygulama isterse herhangi bir şey yaz.",
      firstRun: "WebBrain'de Sağlayıcılar sayfasını aç, Local OpenAI-compatible Proxy'yi seç ve bu adresi yapıştır. API anahtarı isterse herhangi bir şey yaz.",
      gotIt: "Tamam",
      networkNote: "Diğer cihazlar API anahtarıyla bağlanır. Bu ağda anahtara sahip olan herkes aboneliklerini kullanabilir.",
      noNetworkAddr: "Ağ adresi bulunamadı. Bu bilgisayar bir ağa bağlı mı?",
      subs: "Abonelikler",
      add: "Ekle",
      addFirst: "Abonelik ekle",
      emptySubs: "Claude, ChatGPT, Google, Grok ya da Kimi ile giriş yap. Her biri burada ne kadarının kaldığıyla görünür.",
      resetsIn: "{d} sonra sıfırlanır",
      emptyUntil: "{when} tarihine kadar boş",
      paused: "Duraklatıldı",
      reading: "Kullanım okunuyor…",
      noQuotaShort: "Kullanım bildirilmiyor",
      noQuota: "Bu hizmet kullanım bilgisi vermiyor.",
      quotaErrorShort: "Kullanım okunamadı",
      quotaError: "Kullanım okunamadı: {msg}",
      w5h: "5 saat", wday: "Gün", wweek: "Hafta", wmonth: "Ay",
      fivehour: "5 saatlik sınır", daily: "Günlük sınır", weekly: "Haftalık sınır", monthly: "Aylık sınır",
      updated: "{ago} güncellendi",
      refreshUsage: "Yenile",
      refreshing: "Yenileniyor…",
      pause: "Duraklat",
      resume: "Sürdür",
      pausedNote: "Duraklatıldı. Sürdürene kadar WebBrain bu girişi kullanmaz.",
      remove: "Kaldır",
      removeConfirm: "{name} kaldırılsın mı? Daha sonra yeniden giriş yapabilirsin.",
      keep: "Kalsın",
      close: "Kapat",
      models: "Yerel modeller",
      d1Name: "d1 karar modeli",
      compassName: "Compass VLD v6 2B karar modeli",
      modelShortCompass: "Compass VLD v6 2B",
      modelShortD1: "d1",
      decisionModel: "Model",
      useModel: "Bunun yerine {name} kullan",
      deleteOther: "{name} dosyalarını sil ({size})",
      deleteOtherConfirm: "{size} {name} dosyası silinsin mi?",
      runningAs: "{id} olarak çalışıyor",
      installedSize: "Kurulu, {size}",
      downloadSize: "{size} indirme",
      maySlow: "Bu makinede yavaş çalışabilir",
      starting: "Belleğe yükleniyor…",
      stopping: "Durduruluyor…",
      loading: "Yükleniyor…",
      ready: "Hazır",
      readyServed: "Hazır, {n} karar verildi",
      notSupported: "Bu platformda henüz yok",
      install: "Kur",
      cancel: "Vazgeç",
      start: "Başlat",
      stop: "Durdur",
      load: "Yükle",
      unload: "Boşalt",
      retry: "Tekrar dene",
      showLog: "Günlüğü göster",
      ofSize: "{total} içinden {done}",
      eta: "{left} kaldı",
      localLede: "Bu makinede çalışır ve WebBrain'e {id} olarak görünür.",
      thisMachine: "Bu makine",
      format: "Biçim",
      runtime: "Çalışma",
      vision: "Görsel",
      context: "Bağlam",
      onDisk: "Diskte",
      download: "İndirme",
      visionGpu: "Açık",
      visionCpu: "Açık, CPU",
      visionOff: "Kapalı",
      visionBuiltin: "Açık",
      whyBuiltin: "MLX paketi görsel kuleyi içeriyor.",
      whyGpu: "{budget} GPU belleğinin {need} kadarı kullanılınca projektöre yer kalıyor.",
      whyCpu: "GPU belleği dar; görseller CPU'da işleniyor.",
      whyOff: "Görsel projektörü için yeterli bellek kalmıyor.",
      whyForced: "Aşağıda sen ayarladın.",
      tokens: "{n} token",
      layers: "64 katmanın {n} tanesi GPU'da",
      warnFit: "Yaklaşık {need} gerekiyor; bu makinede {budget} var. Yavaş çalışabilir ya da hiç çalışmayabilir.",
      warnPartial: "64 katmanın yalnızca {n} tanesi GPU belleğine sığıyor; kalanı CPU'da çalışır ve daha yavaş olur.",
      warnCpu: "Desteklenen bir GPU bulunamadı, CPU'da çalışacak. Saniyede birkaç token bekle.",
      warnMlx: "MLX için Apple Silicon bir Mac gerekir.",
      formatGGUF: "GGUF", formatMLX: "MLX",
      ggufNote: "llama.cpp (PrismML sürümü), PTQ1_0 ve Q8_0 görsel projektör",
      mlxNote: "mlx-vlm ile MLX 2-bit paket",
      options: "Seçenekler",
      auto: "Otomatik", gpu: "GPU", cpu: "CPU", off: "Kapalı",
      startWith: "Companion ile birlikte başlat",
      removeFiles: "İndirilen dosyaları sil",
      removeFilesConfirm: "{size} model dosyası silinsin mi?",
      delete: "Sil",
      decisionLede: "WebBrain'in karar modeli sayfa hakkındaki evet/hayır, seçim ve puan sorularını tarayıcı yerine burada yanıtlar.",
      endpoint: "Uç nokta",
      served: "Verilen",
      servedValue: "{n} karar, sonuncusu {ms} ms",
      license: "Lisans",
      test: "Deneme kararı çalıştır",
      testing: "Karar veriliyor…",
      testResult: "Yanıt {choice}, %{p} güvenle, {ms} ms.",
      settings: "Ayarlar",
      startLogin: "Oturum açılınca başlat",
      language: "Dil",
      networkToggle: "Bu ağdaki diğer cihazlara izin ver",
      networkHelp: "127.0.0.1 yerine 0.0.0.0'da dinler. Diğer cihazlar API anahtarıyla bağlanır; sistemin gelen bağlantılara izin vermeni isteyebilir.",
      newKey: "Yeni API anahtarı oluştur",
      newKeyConfirm: "Diğer cihazlar yeni anahtarı alana kadar çalışmaz.",
      connection: "Bağlantı",
      port: "Port",
      apply: "Uygula",
      portChanged: "Companion {port} portuna taşındı. Paneli tepsideki simgeden yeniden aç.",
      otherFormats: "Anthropic, Gemini",
      modelsLabel: "Modeller",
      modelsCount: "{n} kullanılabilir",
      modelsNone: "Henüz yok",
      showList: "Göster",
      hideList: "Gizle",
      logFile: "Günlük dosyasını göster",
      version: "Sürüm {v}",
      updates: "Güncellemeler",
      updAuto: "Güncellemeleri otomatik kur",
      updAutoHelp: "Yeni sürümler arka planda iner ve 10 dakika kullanılmadığında kurulur. Ardından Companion kendiliğinden yeniden başlar.",
      updCheck: "Güncellemeleri denetle",
      updChecking: "Güncellemeler denetleniyor…",
      updCurrent: "En yeni sürümü kullanıyorsun.",
      updAvailable: "{v} sürümü çıktı.",
      updDownloading: "{v} sürümü indiriliyor…",
      updReady: "{v} sürümü kurulmaya hazır.",
      updInstalling: "{v} sürümü kuruluyor…",
      updInstall: "Şimdi {v} sürümüne güncelle",
      updFailed: "Güncelleme tamamlanamadı: {e}",
      updPage: "İndirme sayfası",
      quit: "WebBrain Companion'dan çık",
      quitConfirm: "Yeniden açana kadar WebBrain aboneliklerine erişemez.",
      trayHidden: "Menü çubuğu dolu olduğu için macOS, WebBrain Companion simgesini gizliyor. Bu panele her zaman WebBrain Companion'ı yeniden açarak dönebilirsin. Yer açmak için kullanmadığın simgeleri Sistem Ayarları, Menü Çubuğu bölümünden gizle.",
      translocated: "WebBrain Companion, Uygulamalar klasörüne taşınmadığı için macOS'un oluşturduğu geçici bir kopyadan çalışıyor. Uygulamadan çık, Uygulamalar klasörüne taşı ve oradan aç; oturum açılınca başlatma için bu gerekli.",
      pickTitle: "Abonelik ekle",
      pickSub: "Girişi sağlayıcının kendi sayfasında yaparsın. Companion girişi yalnızca bu bilgisayarda saklar.",
      more: "Diğer hizmetler",
      browserFlow: "Tarayıcıda giriş",
      deviceFlow: "Kod gir",
      waitTitle: "{name} girişini tamamla",
      waitBrowser: "Tarayıcında bir giriş sayfası açıldı. Orada erişimi onayla; bu panel kendiliğinden güncellenir.",
      waitDevice: "Aşağıdaki sayfayı aç ve bu kodu gir:",
      openPage: "Giriş sayfasını aç",
      openAgain: "Sayfayı yeniden aç",
      copyCode: "Kodu kopyala",
      waiting: "{name} bekleniyor…",
      noReturn: "Onayladıktan sonra tarayıcı hata mı gösteriyor?",
      pasteHelp: "Tarayıcının adres çubuğundaki tam adresi kopyalayıp buraya yapıştır.",
      pastePh: "http://localhost:…",
      submit: "Girişi tamamla",
      doneTitle: "{name} bağlandı",
      doneSub: "Modelleri artık uç noktanda. Kullanım birazdan görünür.",
      done: "Bitti",
      failTitle: "Giriş tamamlanmadı",
      tokenMissing: "Bu paneli menü çubuğundaki ya da sistem tepsisindeki WebBrain Companion simgesinden aç.",
      ago_now: "az önce", ago_m: "{n} dk önce", ago_h: "{n} sa önce",
      phase_installing: "Kuruluyor",
    },
  };

  let lang = "en";
  const t = (k, vars) => {
    let s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
    if (vars) for (const [n, v] of Object.entries(vars)) s = s.split("{" + n + "}").join(String(v));
    return s;
  };
  // Install steps, machine and runtime descriptions arrive from the companion in
  // English; Turkish gets a translation.
  const STEP_TR = [
    [/^Verifying (.+)$/, (m) => `${goText(m[1])} doğrulanıyor`],
    [/^Bonsai 2 27B weights \((.+)\)$/, (m) => `Bonsai 2 27B ağırlıkları (${m[1]})`],
    [/^Vision projector \((.+)\)$/, (m) => `Görsel projektör (${m[1]})`],
    [/^llama\.cpp runtime \((.+)\)$/, (m) => `llama.cpp çalışma ortamı (${m[1]})`],
    [/^Unpacking llama\.cpp runtime$/, () => "llama.cpp çalışma ortamı açılıyor"],
    [/^Bonsai 2 27B MLX pack$/, () => "Bonsai 2 27B MLX paketi"],
    [/^Model files$/, () => "Model dosyaları"],
    [/^uv \(Python manager\)$/, () => "uv (Python yöneticisi)"],
    [/^Creating Python (\S+) environment$/, (m) => `Python ${m[1]} ortamı hazırlanıyor`],
    [/^Installing MLX and mlx-vlm$/, () => "MLX ve mlx-vlm kuruluyor"],
    [/^Checking the native Bonsai loader$/, () => "Bonsai yükleyicisi denetleniyor"],
    [/^d1 decision model$/, () => "d1 karar modeli"],
    [/^Compass VLD v6 2B$/, () => "Compass VLD v6 2B"],
    [/^Unpacking ONNX Runtime$/, () => "ONNX Runtime açılıyor"],
    [/^(.+) with (\d+) GB unified memory$/, (m) => `${m[1]}, ${m[2]} GB birleşik bellek`],
    [/^(.+) \((\d+) GB\) and (\d+) GB RAM$/, (m) => `${m[1]} (${m[2]} GB), ${m[3]} GB RAM`],
    [/^(.+) with (\d+) GB RAM$/, (m) => `${m[1]}, ${m[2]} GB RAM`],
    [/^(Metal|MLX) on the Apple GPU$/, (m) => `Apple GPU'da ${m[1]}`],
    [/^(CUDA [\d.]+|Vulkan) on (.+)$/, (m) => `${m[2]} üzerinde ${m[1]}`],
    [/^(ONNX Runtime [\d.]+) on the CPU$/, (m) => `CPU'da ${m[1]}`],
  ];
  // Provider descriptions come from the companion in English.
  const PRODUCT_TR = {
    claude: "Pro, Max ya da Team planı",
    codex: "Plus ya da Pro, Codex girişiyle",
    antigravity: "Antigravity üzerinden Gemini",
    xai: "SuperGrok, Grok Build ile",
    "kimi-ai": "kimi.ai üzerinde Kimi Code",
    kimi: "kimi.com üzerinde Kimi Code",
    meta: "Muse Code",
    devin: "Devin hesabı",
  };
  const productText = (p) => (lang === "tr" && PRODUCT_TR[p.id]) || p.product || "";
  function goText(s) {
    if (lang !== "tr" || !s) return s || "";
    for (const [re, f] of STEP_TR) {
      const m = s.match(re);
      if (m) return f(m);
    }
    return s;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // t() for markup: the text is escaped, the values are HTML.
  const th = (k, vars) => {
    let s = esc(t(k));
    for (const [n, v] of Object.entries(vars || {})) s = s.split("{" + n + "}").join(v);
    return s;
  };

  // Icons drawn for this panel.
  const ICON = {
    gear: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M10.34 4.58 10.56 1.9h2.88l.22 2.68 2.41 1 2.05-1.74 2.04 2.04-1.74 2.05 1 2.41 2.68.22v2.88l-2.68.22-1 2.41 1.74 2.05-2.04 2.04-2.05-1.74-2.41 1-.22 2.68h-2.88l-.22-2.68-2.41-1-2.05 1.74-2.04-2.04 1.74-2.05-1-2.41-2.68-.22v-2.88l2.68-.22 1-2.41-1.74-2.05 2.04-2.04 2.05 1.74ZM8.6 12a3.4 3.4 0 1 0 6.8 0 3.4 3.4 0 1 0-6.8 0Z"/></svg>',
    plus: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>',
  };

  const $app = document.getElementById("app");
  const $sheet = document.getElementById("sheet-root");
  const $toast = document.getElementById("toast");

  let state = null;
  let connected = false;
  let firstPaint = true;
  const ui = {
    sheet: null,       // the open sheet: {view, ...}
    returnId: "",      // element to focus when the sheet closes
    confirm: null,     // an inline "are you sure" waiting for an answer
    showKey: false,
    showModels: false,
    refreshing: null,  // {name, since}: a usage refresh asked for in a sheet
    test: null,
    portNote: "",
    portDraft: null,   // a port typed in Settings but not applied yet
    welcomedLocal: false,
  };

  async function api(method, path, body) {
    const res = await fetch("/companion/api" + path, {
      method,
      headers: { "X-Companion-Key": key, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.add("hidden"), 1800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      ta.remove();
    }
    toast(t("copied"));
  }

  // --- formatting -------------------------------------------------------------
  const gb = (b) => {
    if (b < 1e9) return Math.max(1, Math.round(b / 1e6)) + " MB";
    const digits = b >= 1e10 ? 0 : 1;
    return new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(b / 1e9) + " GB";
  };
  const num = (n) => new Intl.NumberFormat(lang).format(n);
  const pctText = (p) => (lang === "tr" ? "%" + Math.round(p) : Math.round(p) + "%");
  function dur(ms) {
    if (ms <= 0) return "";
    const m = Math.round(ms / 60000);
    if (m < 60) return Math.max(1, m) + (lang === "tr" ? " dk" : "m");
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 48) return lang === "tr" ? `${h} sa ${mm} dk` : `${h}h ${String(mm).padStart(2, "0")}m`;
    const d = Math.round(h / 24);
    return lang === "tr" ? `${d} gün` : `${d}d`;
  }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const opts = sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" };
    if (d - now > 6 * 864e5) Object.assign(opts, { month: "short", day: "numeric", weekday: undefined });
    return new Intl.DateTimeFormat(lang, opts).format(d);
  }
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 60000) return t("ago_now");
    const m = Math.round(ms / 60000);
    return m < 60 ? t("ago_m", { n: m }) : t("ago_h", { n: Math.round(m / 60) });
  }

  // --- usage ---------------------------------------------------------------------
  // The window with the least left. Windows for the whole plan come first;
  // scoped ones (one model, code review, extra usage) count only when a plan
  // reports nothing else. The tray menu uses the same rule.
  function tightest(rows) {
    for (const scoped of [false, true]) {
      let best = null;
      for (const r of rows || []) {
        if (r.remaining === null || r.remaining === undefined || !!r.scope !== scoped) continue;
        if (!best || r.remaining < best.remaining) best = r;
      }
      if (best) return best;
    }
    return null;
  }

  function cells(pct, animate) {
    const out = [];
    for (let i = 0; i < 20; i++) {
      const f = Math.max(0, Math.min(1, pct / 5 - i));
      out.push(`<i style="--i:${i};--f:${animate ? 0 : f}" data-f="${f}"></i>`);
    }
    return `<span class="cells" aria-hidden="true">${out.join("")}</span>`;
  }

  function resetText(r) {
    if (!r.reset_at) return "";
    const ms = new Date(r.reset_at) - Date.now();
    if (r.remaining <= 0) return t("emptyUntil", { when: when(r.reset_at) });
    return ms > 0 ? t("resetsIn", { d: dur(ms) }) : "";
  }
  const windowName = (r) => (r.scope && r.window !== "custom" ? r.scope : { "5h": t("w5h"), day: t("wday"), week: t("wweek"), month: t("wmonth") }[r.window] || r.label);
  const windowKind = (r) => ({ "5h": t("fivehour"), day: t("daily"), week: t("weekly"), month: t("monthly") }[r.window] || "");

  // --- main page -----------------------------------------------------------------
  function header() {
    const on = connected && state.running;
    const text = !connected ? t("reconnecting") : state.running ? t("running") : t("stopped");
    return `<header class="top">
      <img src="static/logo-64.png" alt="" width="34" height="34">
      <h1>WebBrain Companion</h1>
      <p class="status"><span class="dot ${on ? "on" : "warn"}"></span>${esc(text)}</p>
    </header>`;
  }

  function banners() {
    const list = [];
    if (state.notice) list.push(esc(state.notice));
    if (state.translocated) list.push(t("translocated"));
    if (state.tray_hidden) list.push(t("trayHidden"));
    if (ui.portNote) list.push(esc(ui.portNote));
    return list.map((x) => `<p class="notice">${x}</p>`).join("");
  }

  const maskKey = (k, short) => (ui.showKey && !short ? k : k.slice(0, 6) + "•".repeat(short ? 6 : 10) + k.slice(-4));

  function addressCard() {
    const url = state.base_url + "/v1";
    const line = (label, value, copyText) => `<div class="addr-row">
        ${label ? `<span class="addr-label">${label}</span>` : ""}
        <span class="addr-value" title="${esc(value)}">${esc(value)}</span>
        <button class="btn small" data-act="copy" data-text="${esc(copyText)}">${t("copy")}</button>
      </div>`;
    let rows = "", note;
    if (state.network) {
      rows = line(t("thisComputer"), url, url);
      const lan = (state.network_urls || [])[0];
      rows += lan ? line(t("otherDevices"), lan, lan) : `<p class="addr-missing">${t("noNetworkAddr")}</p>`;
      rows += line(t("apiKey"), maskKey(state.api_key, true), state.api_key);
      note = t("networkNote");
    } else {
      rows = line("", url, url);
      note = t("noKey");
    }
    const firstRun = !state.welcomed && !ui.welcomedLocal;
    return `<div class="addr ${state.network ? "multi" : ""}">${rows}</div>
      ${firstRun ? `<p class="note first-run">${t("firstRun")} <button class="link" data-act="welcomed">${t("gotIt")}</button></p>`
        : `<p class="note">${note}</p>`}`;
  }

  function subLine(a) {
    const q = a.quota || {};
    if (a.disabled) return { text: t("paused") };
    if (q.status === "loading") return { text: t("reading") };
    if (q.status === "error") return { text: t("quotaErrorShort"), tone: "warn" };
    if (q.status !== "ok") return { text: t("noQuotaShort") };
    const r = tightest(q.rows);
    if (!r) {
      const d = (q.rows || []).find((x) => x.detail);
      return { text: d ? `${windowName(d)}: ${d.detail}` : t("noQuotaShort") };
    }
    const what = resetText(r) || windowKind(r) || windowName(r);
    const text = r.scope && r.window !== "custom" ? `${what} (${r.scope})` : what;
    return { text, row: r, tone: r.remaining <= 0 ? "warn" : "" };
  }

  // Tells logins of the same provider apart, like Account.Who in Go.
  const whoOf = (a) => a.email || String(a.name || "").replace(/\.json$/, "");

  function subRow(a, i, all) {
    const s = subLine(a);
    const q = a.quota || {};
    // Two logins with the same name show whose each one is, as the tray does.
    const shared = all.filter((x) => x.provider_name === a.provider_name).length > 1;
    const who = whoOf(a);
    const r = s.row;
    const low = r && r.remaining < 20;
    const label = [a.provider_name, q.plan, who, r ? pctText(r.remaining) : "", s.text].filter(Boolean).join(", ");
    return `<li class="${a.disabled ? "off" : ""}">
      <button class="item sub-item ${low ? "low" : ""}" id="acc-${i}" data-act="account" data-name="${esc(a.name)}" aria-label="${esc(label)}" title="${esc(who)}">
        <span class="badge" style="--h:${a.hue}" aria-hidden="true">${esc(a.initials)}</span>
        <span class="txt"><span class="name">${esc(a.provider_name)}${q.plan ? ` <span class="plan">${esc(q.plan)}</span>` : ""}</span>
          ${shared ? `<span class="sub">${esc(who)}</span>` : ""}<span class="sub ${s.tone || ""}">${esc(s.text)}</span></span>
        ${r ? cells(Math.max(0, Math.min(100, r.remaining)), firstPaint) + `<span class="pct">${pctText(Math.max(0, Math.min(100, r.remaining)))}</span>` : ""}
      </button>
    </li>`;
  }

  function subsSection() {
    const accounts = state.accounts || [];
    return `<section aria-labelledby="h-subs">
      <div class="sec-head"><h2 id="h-subs">${t("subs")}</h2>
        ${accounts.length ? `<button class="btn small" id="btn-add" data-act="add">${ICON.plus}${t("add")}</button>` : ""}</div>
      ${state.accounts_error ? `<div class="error-box">${esc(state.accounts_error)}</div>` : ""}
      ${accounts.length ? `<ul class="rows">${accounts.map(subRow).join("")}</ul>`
        : `<div class="empty"><p>${t("emptySubs")}</p><button class="btn primary" id="btn-add" data-act="add">${t("addFirst")}</button></div>`}
    </section>`;
  }

  function progressOf(p, busy) {
    if (busy || !p || !p.total) return { busy: true };
    return { pct: (p.done / p.total) * 100 };
  }
  function progressText(p) {
    if (!p || !p.total) return "";
    let s = t("ofSize", { done: gb(p.done), total: gb(p.total) });
    if (p.bytes_per_sec > 0) s += ", " + t("eta", { left: dur(((p.total - p.done) / p.bytes_per_sec) * 1000) });
    return s;
  }
  const bar = (pr) => `<div class="bar ${pr.busy ? "busy" : ""}" aria-hidden="true"><span style="width:${(pr.pct || 0).toFixed(1)}%"></span></div>`;

  function planWarning(L) {
    const p = L.plan;
    if (p.format === "mlx" && !L.system.apple_silicon) return t("warnMlx");
    if (!p.fits) return t("warnFit", { need: gb(p.need_bytes), budget: gb(p.budget_bytes) });
    if (p.gpu_layers > 0 && p.gpu_layers < 64) return t("warnPartial", { n: p.gpu_layers });
    if (p.backend === "cpu") return t("warnCpu");
    return "";
  }
  const canInstall = (L) => !(L.plan.format === "mlx" && !L.system.apple_silicon);
  const localInstalled = (L) => !!(L.installed && L.installed[L.format]);

  // What the Bonsai row says and offers in each phase.
  function localInfo(L) {
    const installed = localInstalled(L);
    switch (L.phase) {
      case "downloading": return { dot: "busy", text: progressText(L.progress) || goText(L.step), act: ["local-cancel", t("cancel")], prog: progressOf(L.progress) };
      case "installing": return { dot: "busy", text: goText(L.step) || t("phase_installing"), act: ["local-cancel", t("cancel")], prog: { busy: true } };
      case "starting": return { dot: "busy", text: t("starting"), prog: { busy: true } };
      case "stopping": return { dot: "busy", text: t("stopping") };
      case "running": return { dot: "on", text: t("runningAs", { id: L.model_id }), act: ["local-stop", t("stop")] };
      case "error": return { dot: "warn", tone: "warn", text: L.error || t("retry"), act: [installed ? "local-start" : "local-install", t("retry")], log: true };
    }
    if (installed) return { text: t("installedSize", { size: gb(L.disk_bytes) }), act: ["local-start", t("start")] };
    const warn = planWarning(L);
    return { text: t("downloadSize", { size: gb(L.download_bytes) }) + (warn ? `. ${t("maySlow")}` : ""), tone: warn ? "warn" : "", act: ["local-install", t("install"), !canInstall(L)] };
  }

  // The decision model in use ("compass" or "d1") and the other one.
  const decisionName = (D) => t(D.id === "d1" ? "d1Name" : "compassName");
  const modelShort = (id) => t(id === "d1" ? "modelShortD1" : "modelShortCompass");

  function d1Info(D) {
    if (!D.supported) return { text: t("notSupported") };
    switch (D.phase) {
      case "downloading": return { dot: "busy", text: progressText(D.progress) || goText(D.step), act: ["d1-cancel", t("cancel")], prog: progressOf(D.progress) };
      case "installing": return { dot: "busy", text: goText(D.step) || t("phase_installing"), act: ["d1-cancel", t("cancel")], prog: { busy: true } };
      case "loading": return { dot: "busy", text: t("loading"), prog: { busy: true } };
      case "ready": return { dot: "on", text: D.requests ? t("readyServed", { n: num(D.requests) }) : t("ready"), act: ["d1-unload", t("unload")] };
      case "error": return { dot: "warn", tone: "warn", text: D.error || t("retry"), act: [D.installed ? "d1-load" : "d1-install", t("retry")], log: true };
    }
    if (D.installed) return { text: t("installedSize", { size: gb(D.disk_bytes) }), act: ["d1-load", t("load")] };
    return { text: t("downloadSize", { size: gb(D.download_bytes) }), act: ["d1-install", t("install")] };
  }

  // a: [action, label, disabled]; what names the model for screen readers.
  const actButton = (a, cls = "", what = "") => (a ? `<button class="btn small ${cls}" data-act="${a[0]}" ${a[2] ? "disabled" : ""}${what ? ` aria-label="${esc(a[1] + ", " + what)}"` : ""}>${esc(a[1])}</button>` : "");

  function modelRow(id, act, badge, color, name, info) {
    return `<li class="model">
      <button class="item" id="${id}" data-act="${act}">
        <span class="badge" style="${color}" aria-hidden="true">${badge}</span>
        <span class="txt"><span class="name">${esc(name)}</span>
          <span class="sub ${info.tone || ""}">${info.dot ? `<span class="dot ${info.dot}"></span>` : ""}${esc(info.text)}</span></span>
      </button>
      ${actButton(info.act, "", name)}
      ${info.prog ? bar(info.prog) : ""}
    </li>`;
  }

  function modelsSection() {
    return `<section aria-labelledby="h-models">
      <div class="sec-head"><h2 id="h-models">${t("models")}</h2></div>
      <ul class="rows">
        ${modelRow("row-local", "local-open", "B", "--h:150;--s:42%;--l:34%", state.local.model_name, localInfo(state.local))}
        ${modelRow("row-d1", "d1-open", state.decision.id === "d1" ? "d1" : "C", "--h:336;--s:58%;--l:46%", decisionName(state.decision), d1Info(state.decision))}
      </ul>
    </section>`;
  }

  function footer() {
    return `<footer class="foot"><button class="btn quiet" id="btn-settings" data-act="settings">${ICON.gear}${t("settings")}</button></footer>`;
  }

  // Re-rendering replaces the markup; keep keyboard focus on the same control.
  function focusSelector(el) {
    if (!el || el === document.body) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    const d = el.dataset || {};
    const attrs = ["act", "change", "name", "id", "text", "format"].filter((k) => d[k] !== undefined)
      .map((k) => `[data-${k}="${CSS.escape(d[k])}"]`).join("");
    return attrs;
  }
  function swap(root, html) {
    if (root.__html === html) return;
    const active = document.activeElement;
    const sel = active && root.contains(active) ? focusSelector(active) : "";
    root.innerHTML = html;
    root.__html = html;
    if (sel) {
      const again = root.querySelector(sel);
      if (again) again.focus({ preventScroll: true });
    }
  }
  const editing = (root) => {
    const a = document.activeElement;
    return !!a && root.contains(a) && (a.tagName === "SELECT" || (a.tagName === "INPUT" && a.type !== "checkbox"));
  };

  let pending = false;
  function render() {
    if (!state) return;
    lang = state.language === "tr" ? "tr" : "en";
    document.documentElement.lang = lang;
    swap($app, header() + banners() + addressCard() + subsSection() + modelsSection() + footer());
    if (firstPaint) {
      firstPaint = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        $app.querySelectorAll(".cells i").forEach((el) => el.style.setProperty("--f", el.dataset.f));
      }));
    }
    renderSheet();
  }

  // --- sheets --------------------------------------------------------------------
  const sheetHead = (title, sub = "", lead = "") => `<div class="sheet-head">${lead}
      <div class="sheet-title"><h3 id="sheet-title">${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ""}</div>
      <button class="icon-btn" data-act="sheet-close" aria-label="${t("close")}">${ICON.close}</button></div>`;

  function confirmRow(text, act, label, attrs = "") {
    return `<div class="confirm" role="group"><span>${esc(text)}</span>
      <span class="confirm-actions"><button class="btn small danger" data-act="${act}" ${attrs}>${esc(label)}</button>
      <button class="btn small quiet" data-act="cancel-confirm">${t("keep")}</button></span></div>`;
  }
  const confirming = (type, name) => ui.confirm && ui.confirm.type === type && (name === undefined || ui.confirm.name === name);

  function meter(r) {
    if (r.remaining === null || r.remaining === undefined) {
      return `<div class="meter"><span class="win" title="${esc(r.label)}">${esc(windowName(r))}</span><span class="when">${esc(r.detail || "")}</span></div>`;
    }
    const pct = Math.max(0, Math.min(100, r.remaining));
    const reset = r.reset_at ? (pct <= 0 ? resetText(r) : (resetText(r) ? `${resetText(r)} (${when(r.reset_at)})` : "")) : "";
    const kind = r.scope && r.window !== "custom" ? windowKind(r) : "";
    const whenLine = [kind, reset, r.detail].filter(Boolean).join(". ");
    return `<div class="meter ${pct < 20 ? "low" : ""}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(windowName(r))}">
      <span class="win" title="${esc(r.label)}">${esc(windowName(r))}</span>
      ${cells(pct, false)}
      <span class="pct">${pctText(pct)}</span>
      ${whenLine ? `<span class="when ${pct <= 0 ? "urgent" : ""}">${esc(whenLine)}</span>` : ""}
    </div>`;
  }

  const refreshingNow = (a) => {
    const r = ui.refreshing;
    return !!r && r.name === a.name && r.since === (a.quota && a.quota.fetched_at) && Date.now() - r.at < 20000;
  };

  function accountSheet(name) {
    const a = (state.accounts || []).find((x) => x.name === name);
    if (!a) return null;
    const q = a.quota || {};
    let body;
    if (a.disabled) body = `<p class="sheet-note">${t("pausedNote")}</p>`;
    else if (q.status === "ok" && (q.rows || []).length) {
      body = `<div class="meters">${q.rows.map(meter).join("")}</div>`
        + (q.error ? `<p class="sheet-note warn">${esc(t("quotaError", { msg: q.error }))}</p>` : "");
    } else if (q.status === "loading") body = `<p class="sheet-note">${t("reading")}</p>`;
    else if (q.status === "error") body = `<p class="sheet-note warn">${esc(t("quotaError", { msg: q.error || "" }))}</p>`;
    else body = `<p class="sheet-note">${t("noQuota")}</p>`;
    const who = `${a.provider_name} (${whoOf(a)})`;
    const actions = confirming("account", a.name)
      ? confirmRow(t("removeConfirm", { name: who }), "remove", t("remove"), `data-name="${esc(a.name)}"`)
      : `<div class="sheet-actions">
          ${a.quota_supported && !a.disabled ? `<span class="updated">${q.fetched_at && q.status === "ok" ? esc(t("updated", { ago: ago(q.fetched_at) })) : ""}</span>
            ${refreshingNow(a) ? `<button class="btn small" disabled>${t("refreshing")}</button>`
              : `<button class="btn small" data-act="refresh-one" data-name="${esc(a.name)}">${t("refreshUsage")}</button>`}` : `<span class="updated"></span>`}
          <button class="btn small" data-act="disable" data-name="${esc(a.name)}" data-off="${!a.disabled}">${a.disabled ? t("resume") : t("pause")}</button>
          <button class="btn small danger" data-act="ask-remove" data-name="${esc(a.name)}">${t("remove")}</button>
        </div>`;
    const title = esc(a.provider_name) + (q.plan ? ` <span class="plan">${esc(q.plan)}</span>` : "");
    return sheetHead(title, esc(whoOf(a)), `<span class="badge big" style="--h:${a.hue}" aria-hidden="true">${esc(a.initials)}</span>`) + body + actions;
  }

  function statusBlock(info) {
    return `<div class="status-block">
      <div class="status-line"><span class="status-text ${info.tone || ""}">${info.dot ? `<span class="dot ${info.dot}"></span>` : ""}${esc(info.text)}</span>
        <span class="status-actions">${info.log ? `<button class="btn small quiet" data-act="logs">${t("showLog")}</button>` : ""}${actButton(info.act, info.dot === "on" || info.dot === "busy" ? "" : "primary")}</span></div>
      ${info.prog ? bar(info.prog) : ""}
    </div>`;
  }

  function visionText(L) {
    const v = L.plan.vision;
    const label = { gpu: t("visionGpu"), cpu: t("visionCpu"), off: t("visionOff"), builtin: t("visionBuiltin") }[v] || v;
    let why;
    if (v === "builtin") why = t("whyBuiltin");
    else if (L.vision_mode && L.vision_mode !== "auto") why = t("whyForced");
    else if (v === "gpu") why = t("whyGpu", { need: gb(L.plan.need_bytes + 960 * 1048576), budget: gb(L.plan.budget_bytes) });
    else if (v === "cpu") why = t("whyCpu");
    else why = t("whyOff");
    return `<span class="${v === "off" ? "vision-off" : "vision-on"}">${esc(label)}</span><span class="why">${esc(why)}</span>`;
  }

  function localSheet() {
    const L = state.local;
    const installed = localInstalled(L);
    const busy = ["downloading", "installing", "starting", "stopping"].includes(L.phase);
    const formats = L.formats || ["gguf"];
    const warn = planWarning(L);
    const info = localInfo(L);
    if (L.phase === "downloading" && L.step) info.text = `${goText(L.step)}: ${info.text}`;
    const fmt = formats.length > 1
      ? `<span class="seg" role="group" aria-label="${t("format")}">${formats.map((f) => `<button data-act="local-format" data-format="${f}" aria-pressed="${f === L.format}" ${busy || L.phase === "running" ? "disabled" : ""}>${t(f === "mlx" ? "formatMLX" : "formatGGUF")}</button>`).join("")}</span>`
      : t("formatGGUF");
    return sheetHead(esc(L.model_name), th("localLede", { id: `<span class="nowrap">${esc(L.model_id)}</span>` }))
      + statusBlock(info)
      + (warn && L.phase !== "running" ? `<p class="sheet-note warn">${esc(warn)}</p>` : "")
      + `<dl class="facts">
        <dt>${t("thisMachine")}</dt><dd>${esc(goText(L.system_summary))}</dd>
        <dt>${t("format")}</dt><dd>${fmt}<span class="why">${t(L.format === "mlx" ? "mlxNote" : "ggufNote")}</span></dd>
        <dt>${t("runtime")}</dt><dd>${esc(goText(L.plan.backend_label))}${L.plan.gpu_layers > 0 && L.plan.gpu_layers < 64 ? `<span class="why">${t("layers", { n: L.plan.gpu_layers })}</span>` : ""}</dd>
        <dt>${t("vision")}</dt><dd>${visionText(L)}</dd>
        <dt>${t("context")}</dt><dd>${esc(t("tokens", { n: num(L.plan.context) }))}</dd>
        ${installed ? `<dt>${t("onDisk")}</dt><dd>${gb(L.disk_bytes)}</dd>` : `<dt>${t("download")}</dt><dd>${gb(L.download_bytes)}</dd>`}
      </dl>
      <h4>${t("options")}</h4>
      <div class="opts">
        ${L.format === "gguf" ? `<label class="setting"><span>${t("vision")}</span>
          <select data-change="local-vision">${["auto", "gpu", "cpu", "off"].map((v) => `<option value="${v}" ${L.vision_mode === v ? "selected" : ""}>${t(v)}</option>`).join("")}</select></label>` : ""}
        <label class="setting"><span>${t("context")}</span>
          <select data-change="local-context">${[0, 8192, 16384, 32768, 65536, 131072, 262144].map((c) => `<option value="${c}" ${state.local_context_setting === c ? "selected" : ""}>${c === 0 ? t("auto") : num(c)}</option>`).join("")}</select></label>
        <label class="toggle"><input type="checkbox" data-change="local-autostart" ${L.auto_start ? "checked" : ""}>${t("startWith")}</label>
      </div>
      ${installed || L.disk_bytes > 0 ? (confirming("local-remove")
        ? confirmRow(t("removeFilesConfirm", { size: gb(L.disk_bytes) }), "local-remove", t("delete"))
        : `<div class="sheet-actions end"><button class="btn small danger" data-act="ask-local-remove" ${busy ? "disabled" : ""}>${t("removeFiles")}</button></div>`) : ""}`;
  }

  function decisionSheet() {
    const D = state.decision;
    const info = d1Info(D);
    if (D.phase === "downloading" && D.step) info.text = `${goText(D.step)}: ${info.text}`;
    let test = "";
    if (D.phase === "ready") {
      test = `<div class="test"><button class="btn small" data-act="d1-test" ${ui.test === "running" ? "disabled" : ""}>${ui.test === "running" ? t("testing") : t("test")}</button>
        ${ui.test && ui.test !== "running" ? `<span class="result">${esc(ui.test)}</span>` : ""}</div>`;
    }
    const busy = ["downloading", "installing", "loading"].includes(D.phase);
    const other = (D.models || []).find((m) => !m.active);
    let otherFiles = "";
    if (other && other.disk_bytes > 0) {
      const vars = { name: modelShort(other.id), size: gb(other.disk_bytes) };
      otherFiles = confirming("d1-remove-other")
        ? confirmRow(t("deleteOtherConfirm", vars), "d1-remove-other", t("delete"), `data-model="${esc(other.id)}"`)
        : `<div class="sheet-actions end"><button class="btn small quiet" data-act="ask-d1-remove-other" ${busy ? "disabled" : ""}>${esc(t("deleteOther", vars))}</button></div>`;
    }
    return sheetHead(esc(decisionName(D)), t("decisionLede"))
      + statusBlock(info) + test
      + `<dl class="facts">
        <dt>${t("decisionModel")}</dt><dd>${esc(modelShort(D.id))}${other ? ` <button class="btn small quiet" data-act="d1-model" data-model="${esc(other.id)}" ${busy ? "disabled" : ""}>${esc(t("useModel", { name: modelShort(other.id) }))}</button>` : ""}</dd>
        <dt>${t("endpoint")}</dt><dd><button class="chip-code" data-act="copy" data-text="${esc(D.endpoint)}" title="${t("copy")}">POST /companion/v1/decide</button></dd>
        ${D.runtime ? `<dt>${t("runtime")}</dt><dd>${esc(goText(D.runtime))}</dd>` : ""}
        ${D.requests ? `<dt>${t("served")}</dt><dd>${esc(t("servedValue", { n: num(D.requests), ms: Math.round(D.last_latency_ms || 0) }))}</dd>` : ""}
        ${D.installed ? `<dt>${t("onDisk")}</dt><dd>${gb(D.disk_bytes)}</dd>` : `<dt>${t("download")}</dt><dd>${gb(D.download_bytes)}</dd>`}
        <dt>${t("license")}</dt><dd>${esc(D.license)}</dd>
      </dl>
      ${D.installed ? (confirming("d1-remove")
        ? confirmRow(t("removeFilesConfirm", { size: gb(D.disk_bytes) }), "d1-remove", t("delete"))
        : `<div class="sheet-actions end"><button class="btn small danger" data-act="ask-d1-remove" ${busy ? "disabled" : ""}>${t("removeFiles")}</button></div>`) : ""}
      ${otherFiles}`;
  }

  // Updates: the automatic-install switch, where the update stands, and a
  // button to check or install now. Development builds never update.
  function updateSection(s) {
    const u = s.update || {};
    if (u.dev) return "";
    const busy = ["checking", "downloading", "installing"].includes(u.state);
    let status = "";
    switch (u.state) {
      case "checking": status = t("updChecking"); break;
      case "downloading": {
        const p = u.progress;
        status = t("updDownloading", { v: u.latest }) + (p && p.total ? ` ${Math.floor((p.done / p.total) * 100)}%` : "");
        break;
      }
      case "installing": status = t("updInstalling", { v: u.latest }); break;
      case "ready": status = t("updReady", { v: u.latest }); break;
      case "error": status = t("updFailed", { e: u.error }); break;
      default: status = u.latest ? t("updAvailable", { v: u.latest }) : (u.checked_at ? t("updCurrent") : "");
    }
    const notes = [status ? `<p class="sheet-note${u.state === "error" ? " warn" : ""}">${esc(status)}</p>` : ""];
    if (u.latest && !u.supported && u.reason) notes.push(`<p class="sheet-note warn">${esc(u.reason)}</p>`);
    const action = u.latest && u.supported
      ? `<button class="btn small primary" data-act="update-install" ${busy ? "disabled" : ""}>${esc(t("updInstall", { v: u.latest }))}</button>`
      : `<button class="btn small" data-act="update-check" ${busy ? "disabled" : ""}>${t("updCheck")}</button>`;
    const page = u.latest && !u.supported ? ` <button class="link" data-act="update-page">${t("updPage")}</button>` : "";
    return `<h4>${t("updates")}</h4>
      <div class="opts">
        <label class="toggle"><input type="checkbox" data-change="auto-update" ${u.auto ? "checked" : ""}>${t("updAuto")}</label>
        <p class="sheet-note">${t("updAutoHelp")}</p>
        ${notes.join("")}
        <div>${action}${page}</div>
      </div>`;
  }

  function settingsSheet() {
    const s = state;
    const models = s.models || [];
    const copyRow = (label, value) => `<div class="kv"><span class="k">${label}</span><span class="v mono" title="${esc(value)}">${esc(value)}</span>
      <button class="btn small" data-act="copy" data-text="${esc(value)}">${t("copy")}</button></div>`;
    let network = "";
    if (s.network) {
      const urls = s.network_urls || [];
      network = (urls.length ? urls.map((u) => copyRow(t("otherDevices"), u)).join("") : `<p class="sheet-note warn">${t("noNetworkAddr")}</p>`)
        + `<div class="kv"><span class="k">${t("apiKey")}</span><span class="v mono">${esc(maskKey(s.api_key))}</span>
          <span class="kv-actions"><button class="btn small quiet" data-act="toggle-key">${ui.showKey ? t("hide") : t("show")}</button>
          <button class="btn small" data-act="copy" data-text="${esc(s.api_key)}">${t("copy")}</button></span></div>`
        + (confirming("rotate") ? confirmRow(t("newKeyConfirm"), "rotate", t("newKey"))
          : `<div><button class="btn small danger" data-act="ask-rotate">${t("newKey")}</button></div>`);
    }
    return sheetHead(t("settings"))
      + `<div class="opts">
        <label class="toggle"><input type="checkbox" data-change="autostart" ${s.autostart ? "checked" : ""} ${s.translocated ? "disabled" : ""}>${t("startLogin")}</label>
        <label class="setting"><span>${t("language")}</span><select data-change="language"><option value="en" ${lang === "en" ? "selected" : ""}>English</option><option value="tr" ${lang === "tr" ? "selected" : ""}>Türkçe</option></select></label>
      </div>
      <h4>${t("otherDevices")}</h4>
      <div class="opts">
        <label class="toggle"><input type="checkbox" data-change="network" ${s.network ? "checked" : ""}>${t("networkToggle")}</label>
        <p class="sheet-note">${t("networkHelp")}</p>
        ${network}
      </div>
      <h4>${t("connection")}</h4>
      <div class="opts">
        <div class="kv"><label class="k" for="port-input">${t("port")}</label><span class="v"><input type="number" min="1024" max="65535" id="port-input" value="${esc(ui.portDraft ?? s.preferred_port)}"></span>
          <button class="btn small" data-act="port">${t("apply")}</button></div>
        ${copyRow(t("otherFormats"), s.base_url)}
        <div class="kv"><span class="k">${t("modelsLabel")}</span><span class="v">${models.length ? t("modelsCount", { n: models.length }) : t("modelsNone")}</span>
          ${models.length ? `<button class="btn small quiet" data-act="toggle-models" aria-expanded="${ui.showModels}">${ui.showModels ? t("hideList") : t("showList")}</button>` : ""}</div>
        ${ui.showModels && models.length ? `<ul class="chips">${models.map((m) => `<li><button data-act="copy" data-text="${esc(m)}" title="${t("copy")}">${esc(m)}</button></li>`).join("")}</ul>` : ""}
      </div>
      ${updateSection(s)}
      <div class="sheet-foot">
        <button class="link" data-act="logs">${t("logFile")}</button>
        <span>${esc(t("version", { v: s.version }))}</span>
      </div>
      ${confirming("quit") ? confirmRow(t("quitConfirm"), "quit", t("quit"))
        : `<div class="sheet-actions"><button class="btn small danger" data-act="ask-quit">${t("quit")}</button></div>`}`;
  }

  function providerRow(p) {
    return `<li><button data-act="pick" data-id="${p.id}">
      <span class="badge" style="--h:${p.hue}" aria-hidden="true">${esc(p.initials)}</span>
      <span class="ptxt"><span class="pname">${esc(p.name)}</span><span class="pprod">${esc(productText(p))}</span></span>
      <span class="ptag">${p.flow === "device" ? t("deviceFlow") : t("browserFlow")}</span></button></li>`;
  }

  function addSheet(s) {
    const prov = s.provider && state.providers.find((p) => p.id === s.provider);
    const name = prov ? prov.name : "";
    if (s.view === "pick") {
      const primary = state.providers.filter((p) => p.primary), rest = state.providers.filter((p) => !p.primary);
      return sheetHead(t("pickTitle"), t("pickSub"))
        + `<ul class="providers">${primary.map(providerRow).join("")}</ul>
        ${rest.length ? `<details class="more" ${s.more ? "open" : ""} data-key="sheet-more"><summary>${t("more")}</summary><ul class="providers">${rest.map(providerRow).join("")}</ul></details>` : ""}`;
    }
    if (s.view === "wait") {
      const st = s.start || {};
      let host = "";
      try { host = new URL(st.url).host; } catch (_) {}
      const cancel = `<div class="sheet-actions"><button class="btn small" data-act="sheet-cancel">${t("cancel")}</button></div>`;
      if (st.flow === "device") {
        return sheetHead(esc(t("waitTitle", { name })), t("waitDevice"))
          + `<div class="code-big">${esc(st.user_code || "")}</div>
          <div class="row"><button class="btn primary" data-act="open-url" data-url="${esc(st.url)}">${t("openPage")}${host ? " (" + esc(host) + ")" : ""}</button>
          <button class="btn" data-act="copy" data-text="${esc(st.user_code || "")}">${t("copyCode")}</button></div>
          <div class="waiting"><span class="spinner"></span>${esc(t("waiting", { name }))}</div>` + cancel;
      }
      return sheetHead(esc(t("waitTitle", { name })), t("waitBrowser"))
        + `<div class="waiting"><span class="spinner"></span>${esc(t("waiting", { name }))}</div>
        <div class="row"><button class="btn" data-act="open-url" data-url="${esc(st.url || "")}" ${st.url ? "" : "disabled"}>${t("openAgain")}</button></div>
        <details class="more" data-key="paste" ${s.paste ? "open" : ""}><summary>${t("noReturn")}</summary>
          <div class="paste"><span class="sheet-note">${t("pasteHelp")}</span>
          <input type="text" id="paste-url" placeholder="${t("pastePh")}" autocomplete="off" spellcheck="false" value="${esc(s.pasteValue || "")}" aria-label="${t("pasteHelp")}">
          <div><button class="btn primary" data-act="paste-submit">${t("submit")}</button></div>
          ${s.pasteError ? `<div class="error-box">${esc(s.pasteError)}</div>` : ""}</div></details>` + cancel;
    }
    if (s.view === "done") {
      return sheetHead(esc(t("doneTitle", { name })), t("doneSub"), `<span class="success-mark" aria-hidden="true">✓</span>`)
        + `<div class="sheet-actions"><button class="btn primary" data-act="sheet-close">${t("done")}</button></div>`;
    }
    return sheetHead(t("failTitle")) + `<div class="error-box">${esc(s.error || "")}</div>
      <div class="sheet-actions"><button class="btn primary" data-act="pick" data-id="${esc(s.provider)}">${t("retry")}</button></div>`;
  }

  // Sheets in the same family share one window, so moving from "pick" to
  // "wait" does not replay the opening animation.
  const sheetFamily = (s) => (["pick", "wait", "done", "error"].includes(s.view) ? "add" : s.view + ":" + (s.name || ""));

  function renderSheet() {
    const s = ui.sheet;
    if (!s) {
      if ($sheet.firstChild) { $sheet.innerHTML = ""; $sheet.__family = ""; }
      $app.inert = false;
      return;
    }
    const family = sheetFamily(s);
    const sameView = $sheet.__family === family && $sheet.__view === s.view;
    if (sameView && editing($sheet)) { pending = true; return; }
    let html;
    switch (s.view) {
      case "account": html = accountSheet(s.name); break;
      case "local": html = localSheet(); break;
      case "decision": html = decisionSheet(); break;
      case "settings": html = settingsSheet(); break;
      default: html = addSheet(s);
    }
    if (html === null) { closeSheet(); return; } // the account went away
    let box = $sheet.querySelector(".sheet");
    const fresh = !box || $sheet.__family !== family;
    if (fresh) {
      $sheet.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1"></div></div>`;
      box = $sheet.querySelector(".sheet");
      box.__html = "";
    }
    const viewChanged = $sheet.__view !== s.view;
    $sheet.__family = family;
    $sheet.__view = s.view;
    swap(box, html);
    $app.inert = true;
    // A new sheet (or a new step of adding a subscription) takes focus itself,
    // so screen readers announce its title and Tab starts at its first control.
    if (fresh || viewChanged || !box.contains(document.activeElement)) box.focus({ preventScroll: true });
  }

  function openSheet(sheet, returnId) {
    ui.sheet = sheet;
    ui.confirm = null;
    if (returnId) ui.returnId = returnId;
    renderSheet();
  }
  function closeSheet() {
    ui.sheet = null;
    ui.confirm = null;
    ui.portDraft = null;
    renderSheet();
    const back = ui.returnId && document.getElementById(ui.returnId);
    if (back) back.focus({ preventScroll: true });
  }

  function syncLogin() {
    const s = ui.sheet;
    if (!s || s.view !== "wait" || !s.start) return;
    const l = (state.logins || []).find((x) => x.state === s.start.state);
    if (!l) return;
    if (l.status === "ok") { ui.sheet = { view: "done", provider: s.provider }; renderSheet(); }
    else if (l.status === "error") { ui.sheet = { view: "error", provider: s.provider, error: l.error }; renderSheet(); }
  }

  async function startLogin(id) {
    ui.sheet = { view: "wait", provider: id, start: null };
    renderSheet();
    const still = () => ui.sheet && ui.sheet.view === "wait" && ui.sheet.provider === id && !ui.sheet.start;
    try {
      const st = await api("POST", "/accounts/login", { provider: id });
      if (still()) ui.sheet = { view: "wait", provider: id, start: st };
      else if (st.state) run(api("DELETE", "/accounts/login/" + encodeURIComponent(st.state))); // closed meanwhile
    } catch (e) {
      if (still()) ui.sheet = { view: "error", provider: id, error: e.message };
    }
    renderSheet();
  }

  // --- actions ------------------------------------------------------------------
  const run = (p) => p.catch((e) => toast(e.message));
  const reRender = () => { render(); };

  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "scrim" && ev.target !== el) return;
    const name = el.dataset.name;
    switch (act) {
      case "copy": copy(el.dataset.text); break;
      case "toggle-key": ui.showKey = !ui.showKey; reRender(); break;
      case "toggle-models": ui.showModels = !ui.showModels; reRender(); break;
      case "welcomed": ui.welcomedLocal = true; reRender(); run(api("PATCH", "/settings", { welcomed: true })); break;
      case "add": openSheet({ view: "pick" }, "btn-add"); break;
      case "account": openSheet({ view: "account", name }, el.id); break;
      case "local-open": openSheet({ view: "local" }, "row-local"); break;
      case "d1-open": openSheet({ view: "decision" }, "row-d1"); break;
      case "settings": openSheet({ view: "settings" }, "btn-settings"); break;
      case "pick": startLogin(el.dataset.id); break;
      case "scrim":
      case "sheet-close": closeSheet(); break;
      case "sheet-cancel":
        if (ui.sheet && ui.sheet.start) run(api("DELETE", "/accounts/login/" + encodeURIComponent(ui.sheet.start.state)));
        closeSheet(); break;
      case "open-url": run(api("POST", "/open", { target: "url", url: el.dataset.url })); break;
      case "paste-submit": {
        const s = ui.sheet;
        s.pasteValue = (document.getElementById("paste-url") || {}).value || "";
        s.paste = true;
        try {
          await api("POST", "/accounts/login/" + encodeURIComponent(s.start.state) + "/callback", { redirect_url: s.pasteValue });
          s.pasteError = "";
        } catch (e) { s.pasteError = e.message; }
        renderSheet();
        break;
      }
      case "refresh-one": {
        const a = state.accounts.find((x) => x.name === name);
        ui.refreshing = { name, since: a && a.quota && a.quota.fetched_at, at: Date.now() };
        reRender();
        setTimeout(reRender, 20500);
        run(api("POST", "/quotas/refresh", { name }));
        break;
      }
      case "disable": run(api("POST", "/accounts/" + encodeURIComponent(name) + "/disabled", { disabled: el.dataset.off === "true" })); break;
      case "ask-remove": ui.confirm = { type: "account", name }; reRender(); break;
      case "remove":
        ui.confirm = null;
        try { await api("DELETE", "/accounts/" + encodeURIComponent(name)); closeSheet(); }
        catch (e) { toast(e.message); reRender(); }
        break;
      case "cancel-confirm": ui.confirm = null; reRender(); break;
      case "local-install": run(api("POST", "/local/install", { format: state.local.format })); break;
      case "local-cancel": run(api("POST", "/local/cancel")); break;
      case "local-start": run(api("POST", "/local/start")); break;
      case "local-stop": run(api("POST", "/local/stop")); break;
      case "local-format": run(api("PATCH", "/local", { format: el.dataset.format })); break;
      case "ask-local-remove": ui.confirm = { type: "local-remove" }; reRender(); break;
      case "local-remove": ui.confirm = null; run(api("POST", "/local/remove", { format: state.local.format })); reRender(); break;
      case "d1-install": run(api("POST", "/decision/install")); break;
      case "d1-cancel": run(api("POST", "/decision/cancel")); break;
      case "d1-load": run(api("POST", "/decision/load")); break;
      case "d1-unload": ui.test = null; run(api("POST", "/decision/unload")); break;
      case "ask-d1-remove": ui.confirm = { type: "d1-remove" }; reRender(); break;
      case "d1-remove": ui.confirm = null; run(api("POST", "/decision/remove")); reRender(); break;
      case "d1-model": ui.test = null; run(api("POST", "/decision/model", { model: el.dataset.model })); break;
      case "ask-d1-remove-other": ui.confirm = { type: "d1-remove-other" }; reRender(); break;
      case "d1-remove-other": ui.confirm = null; run(api("POST", "/decision/remove", { model: el.dataset.model })); reRender(); break;
      case "d1-test": {
        ui.test = "running"; reRender();
        try {
          const r = await api("POST", "/decision/test");
          const a = r.answers && r.answers.completion;
          ui.test = t("testResult", { choice: a ? a.choice : "?", p: a ? Math.round(a.confidence * 100) : 0, ms: Math.round((r.diagnostics && r.diagnostics.latency_ms) || 0) });
        } catch (e) { ui.test = e.message; }
        reRender();
        break;
      }
      case "logs": run(api("POST", "/open", { target: "logs" })); break;
      case "update-check": run(api("POST", "/update/check")); break;
      case "update-install": run(api("POST", "/update/install")); break;
      case "update-page": run(api("POST", "/open", { target: "url", url: (state.update && state.update.page) || "https://github.com/webbrain-one/webbrain/releases" })); break;
      case "port": {
        const v = parseInt((document.getElementById("port-input") || {}).value, 10);
        if (!v || v === state.preferred_port) break;
        try { await api("PATCH", "/settings", { port: v }); ui.portNote = t("portChanged", { port: v }); closeSheet(); reRender(); }
        catch (e) { toast(e.message); }
        break;
      }
      case "ask-rotate": ui.confirm = { type: "rotate" }; reRender(); break;
      case "rotate": ui.confirm = null; run(api("POST", "/key/rotate")); reRender(); break;
      case "ask-quit": ui.confirm = { type: "quit" }; reRender(); break;
      case "quit": ui.confirm = null; run(api("POST", "/quit")); break;
    }
  });

  document.addEventListener("change", (ev) => {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    const v = el.type === "checkbox" ? el.checked : el.value;
    switch (el.dataset.change) {
      case "autostart": run(api("PATCH", "/settings", { autostart: v })); break;
      case "network": run(api("PATCH", "/settings", { network: v })); break;
      case "auto-update": run(api("PATCH", "/settings", { auto_update: v })); break;
      case "language": lang = v; state.language = v; run(api("PATCH", "/settings", { language: v })); el.blur(); reRender(); break;
      case "local-vision": run(api("PATCH", "/local", { vision: v })); el.blur(); break;
      case "local-context": state.local_context_setting = parseInt(v, 10); run(api("PATCH", "/local", { context: parseInt(v, 10) })); el.blur(); break;
      case "local-autostart": run(api("PATCH", "/local", { auto_start: v })); break;
    }
  });

  document.addEventListener("toggle", (ev) => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.key || !ui.sheet) return;
    if (d.dataset.key === "paste") ui.sheet.paste = d.open;
    if (d.dataset.key === "sheet-more") ui.sheet.more = d.open;
  }, true);

  document.addEventListener("focusout", () => { if (pending) { pending = false; setTimeout(render, 0); } });
  document.addEventListener("input", (ev) => {
    if (ev.target.id === "paste-url" && ui.sheet) ui.sheet.pasteValue = ev.target.value;
    if (ev.target.id === "port-input") ui.portDraft = ev.target.value; // kept across live updates
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.id === "port-input") { ev.preventDefault(); document.querySelector('[data-act="port"]').click(); return; }
    if (ev.key !== "Escape") return;
    if (ui.confirm) { ui.confirm = null; reRender(); }
    else if (ui.sheet) closeSheet();
  });

  // --- live state -----------------------------------------------------------------
  function applyState(s) {
    const firstState = !state;
    state = s;
    if (state.local_context_setting === undefined) state.local_context_setting = s.local_context ?? 0;
    connected = true;
    render();
    syncLogin();
    if (firstState) refreshIfStale();
  }

  // Usage refreshes every few minutes in the background; opening the panel
  // asks for fresh numbers when the last ones are older than two minutes.
  function refreshIfStale() {
    const stale = (state.accounts || []).some((a) => a.quota_supported && !a.disabled && a.quota && a.quota.status === "ok"
      && Date.now() - new Date(a.quota.fetched_at).getTime() > 120000);
    if (stale && !state.quota_busy) run(api("POST", "/quotas/refresh", {}));
  }

  function listen() {
    const es = new EventSource("/companion/api/events?key=" + encodeURIComponent(key));
    es.addEventListener("state", (e) => applyState(JSON.parse(e.data)));
    es.onerror = () => {
      connected = false;
      render();
    };
  }

  const fallback = (msg) => {
    $app.innerHTML = `<header class="top"><img src="static/logo-64.png" alt="" width="34" height="34"><h1>WebBrain Companion</h1></header><p class="empty">${msg}</p>`;
  };
  if (!key) { fallback(t("tokenMissing")); return; }
  api("GET", "/state").then((s) => {
    applyState(s);
    if (startView === "add") openSheet({ view: "pick" }, "btn-add");
    else if (startView === "settings") openSheet({ view: "settings" }, "btn-settings");
    else if (startView === "local") openSheet({ view: "local" }, "row-local");
    else if (startView === "decision") openSheet({ view: "decision" }, "row-d1");
    else if (startView.startsWith("account:")) {
      const name = startView.slice(8);
      const i = (state.accounts || []).findIndex((a) => a.name === name);
      if (i >= 0) openSheet({ view: "account", name }, "acc-" + i);
    }
    listen();
  }).catch((e) => fallback(`${esc(e.message)}. ${t("tokenMissing")}`));
  setInterval(() => { if (state) render(); }, 30000); // keep countdowns fresh
})();
