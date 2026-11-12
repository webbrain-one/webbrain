#!/usr/bin/env python3
"""Builds the WebBrain Companion site in the main website's languages from
one template. No dependencies: python3 web/build.py

The pages only show the app's own windows (panel screenshots taken with
WBC_DEMO=1 sample data) and a symbolic tray: a plain field with one status bar
and the companion's real menu, never anyone's desktop.
"""
import html
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LANGUAGES = json.loads((REPO / "web/build/languages.json").read_text(encoding="utf-8"))

SITE = "https://webbrain.one/companion"  # where the pages are published
VERSION = "0.1.4"
RELEASES = "https://github.com/webbrain-one/webbrain/releases"
SOURCE = "https://github.com/webbrain-one/webbrain/tree/main/webbrain-systray"
DL = f"{RELEASES}/download/systray-v{VERSION}/WebBrain-Companion-{VERSION}-"
FILES = {
    "mac": DL + "macos-universal.zip",
    "win": DL + "windows-setup.exe",
    "linux_x64": DL + "linux-x64.tar.gz",
    "linux_arm64": DL + "linux-arm64.tar.gz",
    "sums": DL + "SHA256SUMS.txt",
}
GUIDE = "https://webbrain.one/docs/providers/#companion"

# Tray menu content, as the app renders it (internal/app/menu.go, i18n.go): the
# status, the address, one line per plan with its tightest window, the panel.
MENU = {
    "en": {
        "status": "WebBrain Companion — Running",
        "copy": "Copy",
        "plans": [("Claude Max", 64, "2h 13m"), ("ChatGPT Pro", 57, "4d"), ("Google AI Pro", 71, "5d"), ("Grok SuperGrok", 12, "3d")],
        "open": "Open panel…",
        "quit": "Quit WebBrain Companion",
        "pct": "{}%",
    },
    "tr": {
        "status": "WebBrain Companion — Çalışıyor",
        "copy": "Kopyala",
        "plans": [("Claude Max", 64, "2 sa 13 dk"), ("ChatGPT Pro", 57, "4 gün"), ("Google AI Pro", 71, "5 gün"), ("Grok SuperGrok", 12, "3 gün")],
        "open": "Paneli aç…",
        "quit": "WebBrain Companion'dan çık",
        "pct": "%{}",
    },
}

# What the planner (internal/localmodel/plan.go) picks; see plan_test.go.
MACHINES = {
    "en": [
        ("MacBook Air, 8 GB", "Apple GPU with Metal. It needs more memory than the Mac has, so expect swapping.", "off", "8K"),
        ("MacBook Pro, 16 GB", "Apple GPU with Metal", "gpu", "16K"),
        ("Laptop with an RTX 4060 (8 GB) and 16 GB RAM", "CUDA, 57 of 64 layers on the GPU", "cpu", "8K"),
        ("Desktop with an RTX 4090 (24 GB) and 64 GB RAM", "CUDA, all on the GPU", "gpu", "64K"),
        ("Desktop with a Radeon RX 7600 (8 GB) and 32 GB RAM", "Vulkan, 61 of 64 layers on the GPU", "cpu", "8K"),
        ("PC without a graphics card, 16 GB RAM", "CPU", "cpu", "8K"),
        ("PC without a graphics card, 8 GB RAM", "CPU, with little room to spare", "off", "8K"),
    ],
    "tr": [
        ("MacBook Air, 8 GB", "Apple GPU'da Metal. Mac'teki bellekten fazlasını ister, takas (swap) beklenir.", "off", "8K"),
        ("MacBook Pro, 16 GB", "Apple GPU'da Metal", "gpu", "16K"),
        ("RTX 4060 (8 GB) ve 16 GB RAM'li dizüstü", "CUDA, 64 katmanın 57'si GPU'da", "cpu", "8K"),
        ("RTX 4090 (24 GB) ve 64 GB RAM'li masaüstü", "CUDA, tamamı GPU'da", "gpu", "64K"),
        ("Radeon RX 7600 (8 GB) ve 32 GB RAM'li masaüstü", "Vulkan, 64 katmanın 61'i GPU'da", "cpu", "8K"),
        ("Ekran kartı olmayan, 16 GB RAM'li PC", "CPU", "cpu", "8K"),
        ("Ekran kartı olmayan, 8 GB RAM'li PC", "CPU, payı çok az", "off", "8K"),
    ],
}

T = {
    "en": {
        "title": "WebBrain Companion: your AI subscriptions in WebBrain",
        "og_title": "WebBrain Companion",
        "description": "A small tray app for macOS, Windows and Linux that serves your Claude, ChatGPT, Google, Grok and Kimi subscriptions to WebBrain on 127.0.0.1, shows how much of each plan is left, and runs Bonsai 2 27B on your own machine.",
        "skip": "Skip to content",
        "nav_label": "Sections",
        "nav_panel": "The panel",
        "nav_local": "Local model",
        "nav_connect": "Connect",
        "nav_download": "Download",
        "h1": "The AI plans you already pay for, ready for WebBrain",
        "lede": "WebBrain Companion lives in your menu bar or system tray. Sign in to Claude, ChatGPT, Google, Grok or Kimi once, and WebBrain reaches all of them at one address on your computer. The tray shows how much of each plan is left and when it resets.",
        "get": "Download",
        "get_mac": "Download for macOS",
        "get_win": "Download for Windows",
        "get_linux": "Download for Linux",
        "cta_note": f"Version {VERSION} for macOS, Windows and Linux. Free and open source.",
        "desk_label": "Illustration of the Companion's tray menu: running, the address to copy, and how much is left of Claude Max, ChatGPT Pro, Google AI Pro and SuperGrok.",
        "os_label": "Menu on",
        "panel_h": "Everything else happens in one small panel",
        "panel_intro": "Click the icon to open it. One page holds the address for WebBrain, every plan with what's left, and the two local models; click a row for its details, or the gear for settings. It follows your light or dark setting and speaks English and Turkish.",
        "shot1_h": "One page",
        "shot1_p": "The address WebBrain needs, each plan with the limit closest to running out, and the local models with their main button. No API key on this computer.",
        "shot1_alt": "The panel: the address http://127.0.0.1:8327/v1 with a Copy button, usage meters for Claude Max, ChatGPT Pro, Google AI Pro and SuperGrok, and Bonsai 2 27B running next to the d1 decision model.",
        "shot2_h": "Add a subscription",
        "shot2_p": "Sign in on the provider's own page. The login stays on your computer.",
        "shot2_alt": "The add subscription sheet listing Claude, ChatGPT, Google, Grok and Kimi, each with how you sign in.",
        "shot3_h": "Local models",
        "shot3_p": "Click Bonsai 2 27B to see where it runs and whether images fit, and to change its options. d1 opens the same way.",
        "shot3_alt": "The Bonsai 2 27B details over the panel: running on the Apple GPU with image input on, 65,536 tokens of context, and its options.",
        "local_h": "Bonsai 2 27B, sized to your machine",
        "local_p1": "PrismML's Ternary Bonsai 2 27B packs 27 billion parameters into 5.95 GB. The companion installs it with its Q8_0 vision projector and PrismML's build of llama.cpp, or as the MLX pack on Apple Silicon, and lists it next to your subscriptions as <code>bonsai-2-27b</code>.",
        "local_p2": "Before anything downloads, it works out where the model runs and whether image input fits. The vision projector goes on the GPU when about 1 GB of GPU memory is left after the model and its context, on the CPU when only system RAM has room, and stays off otherwise. You can override the choice in the panel.",
        "table_caption": "What the companion picks on typical machines",
        "th_machine": "Machine",
        "th_runs": "Runs on",
        "th_vision": "Image input",
        "th_context": "Context",
        "vis_gpu": "On, GPU",
        "vis_cpu": "On, CPU",
        "vis_off": "Off",
        "tokens": "{} tokens",
        "local_note": "Worked out by the companion's planner from total and free memory; the numbers on your machine at install time decide. On Apple Silicon the MLX pack carries its own vision tower, so images are always on.",
        "d1_h": "WebBrain's decision model, outside the browser",
        "d1_p": "WebBrain's d1 model answers yes/no, choice and score questions about a page and up to four screenshots, such as whether a task is finished. The companion runs it on ONNX Runtime and answers over HTTP, so a browser tab doesn't have to load 1.9 GB. Its Go port returns the same tokens and probabilities as WebBrain's JavaScript adapter. Native d1 is available on Windows, Linux and Apple Silicon Macs; it is unavailable on Intel Macs.",
        "d1_ask": "Ask",
        "d1_answer": "Answer (273 ms on the CPU runtime)",
        "connect_h": "Connect WebBrain",
        "connect_p": "You do this once. Apps on this computer need no API key.",
        "step1": "Install the companion and open it. Add a subscription in its panel and finish the sign-in in your browser.",
        "step2": "The default address is <code>http://127.0.0.1:8327/v1</code>. If the port changed, copy the address shown in the panel or tray menu.",
        "step3": "In WebBrain, open the <b>Providers</b> page (<b>More…</b> in the side panel's model menu) and choose <b>WebBrain Companion</b>. Keep its default address unless the app shows another port. No API key is needed on this computer.",
        "step4": "Click <b>Load Models</b>, pick a model, <b>Save</b>, and run <b>Test Connection</b> before activating the card. Turn on vision only for a model that accepts images.",
        "after_steps": "Any OpenAI, Anthropic or Gemini client on this computer can use the same address. To use it from another device, turn on network access in the panel's settings; that device then needs the API key the panel shows.",
        "download_h": "Download",
        "download_p": f"Version {VERSION}. Each package holds a single program; your settings and logins live in your user folder.",
        "yours": "Your system",
        "mac_req": "macOS 12 or later, Apple Silicon and Intel (d1 requires Apple Silicon)",
        "mac_file": "Universal app",
        "mac_how": "Move WebBrain Companion to Applications. The build is not notarized by Apple: the first time, allow it in System Settings, Privacy & Security (Open Anyway). On macOS 14 and earlier, Control-click it and choose Open.",
        "win_req": "Windows 10 and 11, x64 and Arm64",
        "win_file": "Installer",
        "win_how": "Run the installer: it installs for your account, without an administrator prompt, and adds WebBrain Companion to the Start menu. Until the installer is code-signed, SmartScreen may say \"Windows protected your PC\": choose More info, then Run anyway.",
        "linux_req": "x64 and Arm64",
        "linux_how": "Unpack and run webbrain-companion. The icon needs a StatusNotifierItem tray: KDE, XFCE, or GNOME with the AppIndicator extension.",
        "sums": "SHA-256 checksums",
        "source": "Source code",
        "all": "All releases",
        "safety_h": "Before you sign in",
        "stays_h": "What stays on your computer",
        "stays": [
            "On this computer no API key is needed: the companion answers only requests from 127.0.0.1 and turns away web pages, so a site you visit can't spend your plans. Browser extensions such as WebBrain and apps on this computer can use it.",
            "Other devices can connect only if you turn on network access in the panel's settings. It then listens on 0.0.0.0, and they need the API key the panel shows.",
            "Logins are stored in your user folder and sent only to the provider they belong to.",
            "There are no analytics. Apart from the providers you sign in to, it only fetches CLIProxyAPI's public model list, and, when you install a model, its files from Hugging Face, GitHub and, for MLX, PyPI.",
            "Prompts sent to a subscription still go to that provider. Only Bonsai 2 27B and d1 run on your machine.",
        ],
        "provider_h": "What your provider decides",
        "provider": [
            "A subscription that works through a proxy is not the same as one the provider allows. Anthropic's consumer terms restrict automated access outside an API key, and Google's Gemini CLI terms say its sign-in may not be used with third-party tools.",
            "Check the terms of your plan and region before you add it. If an account matters to you, a provider API key is the safer route.",
            "Keep network access off on public Wi-Fi, and never forward port 8327 to the internet. The API key is not internet-grade security.",
        ],
        "guide": "Connect WebBrain to Companion",
        "foot": "WebBrain Companion is free software under the GPL-3.0-or-later license and embeds CLIProxyAPI. It is not affiliated with Anthropic, OpenAI, Google, xAI, Moonshot AI, Meta or Cognition.",
        "foot_nav": "More",
    },
    "tr": {
        "title": "WebBrain Companion: yapay zekâ aboneliklerin WebBrain'de",
        "og_title": "WebBrain Companion",
        "description": "Claude, ChatGPT, Google, Grok ve Kimi aboneliklerini WebBrain'e 127.0.0.1 üzerinden sunan, her planda ne kadar hakkın kaldığını gösteren ve Bonsai 2 27B'yi kendi bilgisayarında çalıştıran küçük bir tepsi uygulaması. macOS, Windows ve Linux için.",
        "skip": "İçeriğe geç",
        "nav_label": "Bölümler",
        "nav_panel": "Panel",
        "nav_local": "Yerel model",
        "nav_connect": "Bağlantı",
        "nav_download": "İndir",
        "h1": "Zaten ödediğin yapay zekâ aboneliklerini WebBrain'de kullan",
        "lede": "WebBrain Companion menü çubuğunda ya da sistem tepsisinde durur. Claude, ChatGPT, Google, Grok veya Kimi hesabına bir kez giriş yap; WebBrain hepsine bilgisayarındaki tek bir adresten ulaşsın. Tepsi, her planda ne kadar hakkın kaldığını ve ne zaman sıfırlanacağını gösterir.",
        "get": "İndir",
        "get_mac": "macOS için indir",
        "get_win": "Windows için indir",
        "get_linux": "Linux için indir",
        "cta_note": f"Sürüm {VERSION}; macOS, Windows ve Linux için. Ücretsiz ve açık kaynak.",
        "desk_label": "Companion'ın tepsi menüsünün çizimi: çalışıyor, kopyalanacak adres ve Claude Max, ChatGPT Pro, Google AI Pro ile SuperGrok'ta ne kadar hak kaldığı.",
        "os_label": "Menü",
        "panel_h": "Gerisi tek bir küçük panelde",
        "panel_intro": "Paneli simgeye tıklayarak açarsın. Tek sayfada WebBrain'in adresi, her planda kalan hak ve iki yerel model durur; ayrıntılar için bir satıra, ayarlar için dişli simgesine tıkla. Panel açık ya da koyu temana uyar; Türkçe ve İngilizce konuşur.",
        "shot1_h": "Tek sayfa",
        "shot1_p": "WebBrain'in istediği adres, her planın bitmeye en yakın sınırı ve ana düğmeleriyle yerel modeller. Bu bilgisayarda API anahtarı yok.",
        "shot1_alt": "Panel: Kopyala düğmesiyle http://127.0.0.1:8327/v1 adresi; Claude Max, ChatGPT Pro, Google AI Pro ve SuperGrok kullanım göstergeleri; çalışan Bonsai 2 27B ve d1 karar modeli.",
        "shot2_h": "Abonelik ekleme",
        "shot2_p": "Girişi sağlayıcının kendi sayfasında yaparsın. Oturum bilgisi bilgisayarında kalır.",
        "shot2_alt": "Abonelik ekleme penceresi: Claude, ChatGPT, Google, Grok ve Kimi, her birinin giriş yöntemiyle.",
        "shot3_h": "Yerel modeller",
        "shot3_p": "Bonsai 2 27B'ye tıkla: nerede çalıştığını ve görsellerin sığıp sığmadığını görür, seçeneklerini değiştirirsin. d1 de aynı şekilde açılır.",
        "shot3_alt": "Panelin üzerinde Bonsai 2 27B ayrıntıları: Apple GPU'da görsel girdi açık çalışıyor, 65.536 token bağlam ve seçenekleri.",
        "local_h": "Bonsai 2 27B, makinene göre ayarlanır",
        "local_p1": "PrismML'in Ternary Bonsai 2 27B modeli 27 milyar parametreyi 5,95 GB'a sığdırır. Companion onu Q8_0 görsel projektörüyle ve PrismML'in llama.cpp sürümüyle, Apple Silicon'da istersen MLX paketi olarak kurar ve aboneliklerinin yanında <code>bonsai-2-27b</code> adıyla sunar.",
        "local_p2": "Daha hiçbir şey inmeden modelin nerede çalışacağını ve görsel girdinin sığıp sığmayacağını hesaplar. Model ve bağlamı yerleştikten sonra GPU'da yaklaşık 1 GB yer kalıyorsa görsel projektör GPU'ya, yalnızca sistem belleğinde yer varsa CPU'ya gider; ikisi de yoksa kapalı kalır. Bu seçimi panelden değiştirebilirsin.",
        "table_caption": "Tipik makinelerde Companion'ın seçtikleri",
        "th_machine": "Makine",
        "th_runs": "Nerede çalışır",
        "th_vision": "Görsel girdi",
        "th_context": "Bağlam",
        "vis_gpu": "Açık, GPU",
        "vis_cpu": "Açık, CPU",
        "vis_off": "Kapalı",
        "tokens": "{} token",
        "local_note": "Companion'ın planlayıcısı toplam ve boş belleğe bakarak hesaplar; son kararı kurulum anında makinendeki değerler verir. Apple Silicon'da MLX paketi kendi görsel katmanını taşır, görsel girdi her zaman açıktır.",
        "d1_h": "WebBrain'in karar modeli, tarayıcının dışında",
        "d1_p": "WebBrain'in d1 modeli bir sayfa ve en fazla dört ekran görüntüsü hakkında evet/hayır, seçim ve puan sorularını yanıtlar; örneğin bir görevin bitip bitmediğini. Companion modeli ONNX Runtime ile çalıştırır ve HTTP üzerinden yanıtlar; böylece 1,9 GB'lık modeli bir tarayıcı sekmesi yüklemek zorunda kalmaz. Go'ya taşınan sürüm, WebBrain'in JavaScript adaptörüyle aynı token'ları ve olasılıkları verir. Yerel d1 Windows, Linux ve Apple Silicon Mac'lerde kullanılabilir; Intel Mac'lerde kullanılamaz.",
        "d1_ask": "Soru",
        "d1_answer": "Yanıt (CPU'da 273 ms)",
        "connect_h": "WebBrain'i bağla",
        "connect_p": "Bunu bir kez yaparsın. Bu bilgisayardaki uygulamaların API anahtarına ihtiyacı yok.",
        "step1": "Companion'ı kur ve aç. Panelinden bir abonelik ekle ve girişi tarayıcında tamamla.",
        "step2": "Varsayılan adres <code>http://127.0.0.1:8327/v1</code>. Port değiştiyse panelde veya tepsi menüsünde gösterilen adresi kopyala.",
        "step3": "WebBrain'de <b>Sağlayıcılar</b> sayfasını aç (yan paneldeki model menüsünde <b>Daha fazla…</b>) ve <b>WebBrain Companion</b>'ı seç. Uygulama farklı bir port göstermiyorsa varsayılan adresi koru. Bu bilgisayarda API anahtarı gerekmez.",
        "step4": "<b>Modelleri yükle</b>'ye bas, bir model seç, <b>Kaydet</b> ve kartı etkinleştirmeden önce <b>Bağlantıyı sına</b>. Görseli yalnızca resim kabul eden bir model için aç.",
        "after_steps": "Bu bilgisayardaki OpenAI, Anthropic ya da Gemini uyumlu her istemci aynı adresi anahtarsız kullanabilir. Başka bir cihazdan kullanmak için panelin ayarlarından ağ erişimini aç; o cihaz panelin gösterdiği API anahtarını kullanmalı.",
        "download_h": "İndir",
        "download_p": f"Sürüm {VERSION}. Her paket tek bir program içerir; ayarların ve girişlerin kullanıcı klasöründe durur.",
        "yours": "Senin sistemin",
        "mac_req": "macOS 12 ve sonrası, Apple Silicon ve Intel (d1 için Apple Silicon gerekli)",
        "mac_file": "Universal uygulama",
        "mac_how": "WebBrain Companion'ı Uygulamalar klasörüne taşı. Sürüm Apple onayından (notarization) geçmedi: ilk açılışta Sistem Ayarları, Gizlilik ve Güvenlik bölümünden izin ver (Yine de Aç). macOS 14 ve öncesinde Control tuşuyla tıklayıp Aç'ı seçmen yeterli.",
        "win_req": "Windows 10 ve 11, x64 ve Arm64",
        "win_file": "Kurulum dosyası",
        "win_how": "Kurulum dosyasını çalıştır: yönetici izni istemeden senin hesabına kurar ve WebBrain Companion'ı Başlat menüsüne ekler. Kurulum dosyası kod imzalı olana kadar SmartScreen \"Windows bilgisayarınızı korudu\" diyebilir: Ek bilgi'yi, ardından Yine de çalıştır'ı seç.",
        "linux_req": "x64 ve Arm64",
        "linux_how": "Arşivi aç ve webbrain-companion'ı çalıştır. Simge için StatusNotifierItem destekli bir tepsi gerekir: KDE, XFCE ya da AppIndicator eklentili GNOME.",
        "sums": "SHA-256 özetleri",
        "source": "Kaynak kodu",
        "all": "Tüm sürümler",
        "safety_h": "Giriş yapmadan önce",
        "stays_h": "Bilgisayarında kalanlar",
        "stays": [
            "Bu bilgisayarda API anahtarı gerekmez: Companion yalnızca 127.0.0.1'den gelen istekleri yanıtlar ve web sayfalarını geri çevirir; böylece girdiğin bir site planlarını harcayamaz. WebBrain gibi tarayıcı eklentileri ve bu bilgisayardaki uygulamalar onu kullanabilir.",
            "Diğer cihazlar yalnızca panelin ayarlarından ağ erişimini açarsan bağlanabilir. Companion o zaman 0.0.0.0'da dinler ve o cihazlar panelin gösterdiği API anahtarını kullanmalıdır.",
            "Girişler kullanıcı klasöründe saklanır ve yalnızca ait oldukları sağlayıcıya gönderilir.",
            "Analitik yok. Giriş yaptığın sağlayıcılar dışında yalnızca CLIProxyAPI'nin herkese açık model listesini alır; bir model kurduğunda da dosyalarını Hugging Face'ten, GitHub'dan ve MLX için PyPI'dan indirir.",
            "Bir aboneliğe giden istemler yine o sağlayıcıya gider. Bilgisayarında çalışan yalnızca Bonsai 2 27B ve d1'dir.",
        ],
        "provider_h": "Sağlayıcının belirledikleri",
        "provider": [
            "Bir aboneliğin proxy üzerinden çalışması, sağlayıcının buna izin verdiği anlamına gelmez. Anthropic'in tüketici koşulları API anahtarı dışındaki otomatik erişimi kısıtlar; Google'ın Gemini CLI koşulları da bu girişin üçüncü taraf araçlarla kullanılamayacağını söyler.",
            "Eklemeden önce planının ve bölgenin koşullarına bak. Hesabın senin için önemliyse sağlayıcının API anahtarı daha güvenli yoldur.",
            "Herkese açık Wi-Fi'da ağ erişimini kapalı tut ve 8327 portunu asla internete yönlendirme. API anahtarı internete dayanacak bir güvenlik sağlamaz.",
        ],
        "guide": "WebBrain'i Companion'a bağlama rehberi (İngilizce)",
        "foot": "WebBrain Companion, GPL-3.0-or-later lisanslı özgür bir yazılımdır ve CLIProxyAPI'yi içinde barındırır. Anthropic, OpenAI, Google, xAI, Moonshot AI, Meta ya da Cognition ile bağlantılı değildir.",
        "foot_nav": "Bağlantılar",
    },
}

D1_ASK = r"""curl http://127.0.0.1:8327/companion/v1/decide \
  -H "Content-Type: application/json" \
  -d '{"state": "Order #1042 is confirmed.",
       "questions": {"completion": {
         "type": "choice",
         "instructions": "Did the task finish?",
         "criteria": {"completed": "Confirmed",
                      "not_completed": "Failed or unfinished",
                      "unknown": "Not established"}}}}'"""

D1_ANSWER = """{"answers": {"completion": {
   "choice": "completed",
   "confidence": 0.99997,
   "probabilities": {"completed": 0.99997,
                     "not_completed": 0.000002,
                     "unknown": 0.000033}}},
 "diagnostics": {"runtime": "onnxruntime 1.31.0 (CPU)", …}}"""

PAGE = r"""<!doctype html>
<html lang="[[lang]]" dir="[[direction]]" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[[title]]</title>
<meta name="description" content="[[description]]">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbf6f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a0f18" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="[[canonical]]">
[[alternates]]
<link rel="alternate" hreflang="x-default" href="[[site]]/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="WebBrain">
<meta property="og:title" content="[[og_title]]">
<meta property="og:description" content="[[description]]">
<meta property="og:url" content="[[canonical]]">
<meta property="og:image" content="[[site]]/assets/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="[[root]]assets/img/favicon.png">
<link rel="preload" href="[[root]]assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="[[root]]assets/site.css">
<script>document.documentElement.classList.replace("no-js", "js")</script>
<script defer src="[[root]]assets/site.js"></script>
</head>
<body>
<a class="skip" href="#main">[[skip]]</a>
<header class="wrap site-head">
  <a class="brand" href="[[home]]"><img src="[[root]]assets/img/logo-128.png" alt="" width="30" height="30">WebBrain Companion</a>
  <nav class="site-nav" aria-label="[[nav_label]]">
    <a href="#panel">[[nav_panel]]</a>
    <a href="#local">[[nav_local]]</a>
    <a href="#connect">[[nav_connect]]</a>
    <a href="#download">[[nav_download]]</a>
  </nav>
  <details class="language-picker">
    <summary aria-label="[[language_label]]" title="[[language_label]]">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></svg>
    </summary>
    <nav class="language-menu" aria-label="[[language_label]]">
[[language_links]]
    </nav>
  </details>
</header>

<main id="main">
<section class="wrap hero">
  <div>
    <h1>[[h1]]</h1>
    <p class="lede">[[lede]]</p>
    <div class="cta">
      <a class="button primary" id="get" href="#download" data-mac="[[get_mac]]" data-win="[[get_win]]" data-linux="[[get_linux]]" data-mac-href="[[dl_mac]]" data-win-href="[[dl_win]]" data-linux-href="#download">[[get]]</a>
      <span class="cta-note">[[cta_note]]</span>
    </div>
  </div>
  <div class="desk-wrap">
    <div class="desk" data-os="mac" role="img" aria-label="[[desk_label]]">
      <div class="bar" aria-hidden="true"><span class="s s3"></span><span class="s s2"></span><span class="icon"><span class="glyph"></span></span><span class="s s1"></span></div>
      <div class="menu" aria-hidden="true">
[[menu]]
      </div>
    </div>
    <div class="os-switch"><span id="os-label">[[os_label]]</span><span class="seg" role="group" aria-labelledby="os-label"><button type="button" data-os="mac" aria-pressed="true">macOS</button><button type="button" data-os="win" aria-pressed="false">Windows</button><button type="button" data-os="linux" aria-pressed="false">Linux</button></span></div>
  </div>
</section>

<section class="section" id="panel" aria-labelledby="panel-h">
  <div class="wrap">
    <h2 id="panel-h">[[panel_h]]</h2>
    <p class="intro">[[panel_intro]]</p>
    <ul class="windows">
[[windows]]
    </ul>
  </div>
</section>

<section class="section" id="local" aria-labelledby="local-h">
  <div class="wrap">
    <h2 id="local-h">[[local_h]]</h2>
    <div class="split">
      <p class="intro">[[local_p1]]</p>
      <p class="intro">[[local_p2]]</p>
    </div>
    <table class="machines">
      <caption>[[table_caption]]</caption>
      <thead><tr><th scope="col">[[th_machine]]</th><th scope="col">[[th_runs]]</th><th scope="col">[[th_vision]]</th><th scope="col">[[th_context]]</th></tr></thead>
      <tbody>
[[machines]]
      </tbody>
    </table>
    <p class="note">[[local_note]]</p>
  </div>
</section>

<section class="section" id="decision" aria-labelledby="d1-h">
  <div class="wrap">
    <h2 id="d1-h">[[d1_h]]</h2>
    <div class="split">
      <p class="intro">[[d1_p]]</p>
      <div>
        <p class="code-label">[[d1_ask]]</p>
        <pre><code>[[d1_code]]</code></pre>
        <p class="code-label">[[d1_answer]]</p>
        <pre><code>[[d1_result]]</code></pre>
      </div>
    </div>
  </div>
</section>

<section class="section" id="connect" aria-labelledby="connect-h">
  <div class="wrap">
    <h2 id="connect-h">[[connect_h]]</h2>
    <p class="intro">[[connect_p]]</p>
    <ol class="steps">
      <li>[[step1]]</li>
      <li>[[step2]]</li>
      <li>[[step3]]</li>
      <li>[[step4]]</li>
    </ol>
    <p class="after-steps">[[after_steps]]</p>
  </div>
</section>

<section class="section" id="download" aria-labelledby="download-h">
  <div class="wrap">
    <h2 id="download-h">[[download_h]]</h2>
    <p class="intro">[[download_p]]</p>
    <div class="downloads">
      <div class="dl" data-os="mac">
        <div><h3>macOS</h3><p class="req">[[mac_req]]</p><span class="yours">[[yours]]</span></div>
        <ul class="files"><li><a href="[[dl_mac]]">[[mac_file]] <small>zip, 36 MB</small></a></li></ul>
        <p class="how">[[mac_how]]</p>
      </div>
      <div class="dl" data-os="win">
        <div><h3>Windows</h3><p class="req">[[win_req]]</p><span class="yours">[[yours]]</span></div>
        <ul class="files"><li><a href="[[dl_win]]">[[win_file]] <small>setup.exe, 23 MB</small></a></li></ul>
        <p class="how">[[win_how]]</p>
      </div>
      <div class="dl" data-os="linux">
        <div><h3>Linux</h3><p class="req">[[linux_req]]</p><span class="yours">[[yours]]</span></div>
        <ul class="files"><li><a href="[[dl_linux_x64]]">x64 <small>tar.gz, 20 MB</small></a></li><li><a href="[[dl_linux_arm64]]">Arm64 <small>tar.gz, 18 MB</small></a></li></ul>
        <p class="how">[[linux_how]]</p>
      </div>
    </div>
    <p class="more-links"><a href="[[dl_sums]]">[[sums]]</a><a href="[[source]]">[[source_label]]</a><a href="[[releases]]">[[all]]</a></p>
  </div>
</section>

<section class="section safety" id="safety" aria-labelledby="safety-h">
  <div class="wrap">
    <h2 id="safety-h">[[safety_h]]</h2>
    <div class="split even">
      <div>
        <h3>[[stays_h]]</h3>
        <ul class="facts">
[[stays]]
        </ul>
      </div>
      <div>
        <h3>[[provider_h]]</h3>
        <ul class="facts">
[[provider]]
        </ul>
        <p><a href="[[guide_url]]">[[guide]]</a></p>
      </div>
    </div>
  </div>
</section>
</main>

<footer class="site-foot">
  <div class="wrap">
    <p>[[foot]]</p>
    <nav aria-label="[[foot_nav]]"><a href="https://webbrain.one/">WebBrain</a><a href="[[source]]">[[source_label]]</a></nav>
  </div>
</footer>
</body>
</html>
"""


def esc(s):
    return html.escape(s, quote=True)


def meter(v):
    n = int(v / 10 + 0.5)  # same rounding as the tray (math.Round)
    return '<span class="meter">' + '<i class="on"></i>' * n + "<i></i>" * (10 - n) + "</span>"


def menu_html(lang):
    m = MENU[lang]
    rows = []
    add = rows.append
    add(f'<div class="row dim"><span>{esc(m["status"])}</span></div>')
    add(f'<div class="row"><span>{esc(m["copy"])}&nbsp;&nbsp;http://127.0.0.1:8327/v1</span></div>')
    add('<div class="sep"></div>')
    for name, v, reset in m["plans"]:
        pct = m["pct"].format(v)
        add(f'<div class="row plan"><span>{esc(name)}</span>{meter(v)}<span>{pct} · {esc(reset)}</span></div>')
    add('<div class="sep"></div>')
    add(f'<div class="row"><span>{esc(m["open"])}</span></div>')
    add(f'<div class="row"><span>{esc(m["quit"])}</span></div>')
    return "\n".join("        " + r for r in rows)


def windows_html(lang, root, t):
    out = []
    # The app itself currently has English and Turkish screenshots.
    shot_lang = lang if lang in ("en", "tr") else "en"
    for i, shot in enumerate(["panel", "add", "local"], 1):
        out.append(f"""      <li><figure>
        <div class="window"><div class="titlebar" aria-hidden="true"><i></i><i></i><i></i><span>WebBrain Companion</span></div>
          <picture><source srcset="{root}assets/img/{shot}-{shot_lang}-dark.webp" media="(prefers-color-scheme: dark)"><img src="{root}assets/img/{shot}-{shot_lang}-light.webp" width="460" height="760" alt="{esc(t[f'shot{i}_alt'])}" loading="lazy" decoding="async"></picture></div>
        <figcaption><h3>{esc(t[f'shot{i}_h'])}</h3><p>{esc(t[f'shot{i}_p'])}</p></figcaption>
      </figure></li>""")
    return "\n".join(out)


def machines_html(lang, t):
    out = []
    for name, runs, vis, ctx in MACHINES[lang]:
        out.append(
            f'        <tr><td>{esc(name)}</td><td data-label="{esc(t["th_runs"])}">{esc(runs)}</td>'
            f'<td data-label="{esc(t["th_vision"])}"><span class="vis {vis}">{esc(t["vis_" + vis])}</span></td>'
            f'<td data-label="{esc(t["th_context"])}">{esc(t["tokens"].format(ctx))}</td></tr>'
        )
    return "\n".join(out)


def language_links(lang, root):
    links = []
    for locale in LANGUAGES:
        code = locale["code"]
        href = root + ("" if locale["isDefault"] else code + "/")
        current = ' aria-current="page"' if code == lang else ""
        links.append(f'      <a href="{href}" hreflang="{code}" lang="{code}" dir="{locale["dir"]}"{current}>{esc(locale["label"])}</a>')
    return "\n".join(links)


def render(lang):
    locale = next(item for item in LANGUAGES if item["code"] == lang)
    if lang not in T:
        copy = json.loads((HERE / "locales" / f"{lang}.json").read_text(encoding="utf-8"))
        T[lang], MENU[lang], MACHINES[lang] = copy["text"], copy["menu"], copy["machines"]
        for key in ("cta_note", "download_p"):
            T[lang][key] = T[lang][key].replace("{version}", VERSION)
    t = T[lang]
    root = "" if lang == "en" else "../"
    v = {k: esc(x) for k, x in t.items() if isinstance(x, str)}
    # Strings that carry inline markup (<code>, <b>) are written as HTML on purpose.
    for k in ("local_p1", "step1", "step2", "step3", "step4"):
        v[k] = t[k]
    v.update(
        lang=lang,
        direction=locale["dir"],
        root=root,
        home="./",
        site=SITE,
        canonical=SITE + ("/" if lang == "en" else f"/{lang}/"),
        alternates="\n".join(f'<link rel="alternate" hreflang="{item["code"]}" href="{SITE}/{"" if item["isDefault"] else item["code"] + "/"}">' for item in LANGUAGES),
        language_label=esc(json.loads((REPO / "web/build/locales" / f"{lang}.json").read_text(encoding="utf-8"))["nav.language_aria"]),
        language_links=language_links(lang, root),
        dl_mac=FILES["mac"],
        dl_win=FILES["win"],
        dl_linux_x64=FILES["linux_x64"],
        dl_linux_arm64=FILES["linux_arm64"],
        dl_sums=FILES["sums"],
        releases=RELEASES,
        source=SOURCE,
        source_label=esc(t["source"]),
        guide_url=GUIDE,
        menu=menu_html(lang),
        windows=windows_html(lang, root, t),
        machines=machines_html(lang, t),
        d1_code=esc(D1_ASK),
        d1_result=esc(D1_ANSWER),
        stays="\n".join(f"          <li>{esc(s)}</li>" for s in t["stays"]),
        provider="\n".join(f"          <li>{esc(s)}</li>" for s in t["provider"]),
    )

    def sub(m):
        key = m.group(1)
        if key not in v:
            raise KeyError(f"{lang}: missing [[{key}]]")
        return v[key]

    return re.sub(r"\[\[(\w+)\]\]", sub, PAGE)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for locale in LANGUAGES:
        lang = locale["code"]
        path = "index.html" if locale["isDefault"] else os.path.join(lang, "index.html")
        out = os.path.join(here, path)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(render(lang))
        print("wrote", os.path.relpath(out, here))


if __name__ == "__main__":
    main()
