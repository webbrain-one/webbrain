<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain のロゴ" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  ページとのチャット、タスクの自動化、複数ステップのワークフローの実行を、好きな LLM で行えるオープンソースの AI ブラウザエージェントです。
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Install WebBrain from the Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Install WebBrain from Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Install WebBrain from Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.hi.md">हिन्दी</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.tr.md">Türkçe</a> ·
  <a href="docs/">ドキュメント</a> ·
  <a href="https://webbrain.one">Web サイト</a> ·
  <a href="https://discord.gg/cgC325ssfw">Discord</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![WebBrain がページを読み、フォームに入力し、ファイルを取得している様子](assets/webbrain-demo.gif)

WebBrain は、タブの横のサイドパネルに AI エージェントを置く Web ブラウザの拡張機能です。
今開いているページについて質問したり、タスクを任せてクリック、入力、ナビゲーションを
こなしてもらったりできます。動作するモデルは自由に選べます：ローカルの
llama.cpp や Ollama のサーバー、最先端のクラウド API、あるいはセットアップが
一切不要なマネージドのデフォルトのモデルです。

## インストール

[Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb)、
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/webbrain/)、または
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo) からインストールしてください。

<details>
<summary><b>またはソースから読み込む</b></summary>

```bash
git clone --filter=blob:none https://github.com/webbrain-one/webbrain.git
```

**Chrome** — `chrome://extensions/` を開き、（右上の）**デベロッパー モード** を有効にして、
**パッケージ化されていない拡張機能を読み込む** をクリックし、`webbrain/src/chrome` フォルダーを選択します。
作業ツリーの余計なファイルを拾わない独立したコピーを使うには、
先に `npm run build:chrome` を実行して、代わりに `webbrain/build/chrome` を読み込んでください。

**Firefox** — `about:debugging#/runtime/this-firefox` を開き、**一時的なアドオンを読み込む** を
クリックして、`src/firefox/manifest.json`（または `npm run build:firefox` のあとの
`build/firefox/manifest.json`）を選択します。一時的なアドオンは
Firefox を再起動すると削除されます。永続的にインストールするには、
[addons.mozilla.org](https://addons.mozilla.org) での署名が必要です。

</details>

## 使い方

WebBrain のアイコンをクリックしてサイドパネルを開き、たとえば次のように入力します：

- 「このページを要約して」
- 「料金に関するリンクをすべて見つけて」
- 「検索ボックスに 'AI agents' と入力して、Search をクリックして」
- 「github.com に移動して、トレンドのリポジトリを見つけて」

エージェントに何を許可するかは、3 つのモードで制御します：

| モード    | できること                                                         |
| ------- | ---------------------------------------------------------------------- |
| **Ask** | 読み取り専用。ページを読み、質問に答え、URL を取得します。            |
| **Act** | クリック、入力、ナビゲーション、アップロード、ダウンロード、フォームの入力を行います。             |
| **Dev** | ページのソース、スタイル、コンソール、ネットワーク、元に戻せるページの編集を追加します。 |

WebBrain はメッセージごとにモードを選びます：メッセージでブラウザ上での操作を求めない限り、
Ask のままです。モードを自分で選ぶには、メッセージを `/ask`、`/act`、
`/dev` で始めてください。

## モデルを選ぶ

**WebBrain Compass 1.0** がデフォルトで、API キーもローカルのセットアップも必要ありません。

**ローカルモデル** にも API キーは不要です。WebBrain を、OpenAI 互換の任意の
サーバーに向けてください：

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio（`:1234/v1`）、Osaurus（`:1337/v1`）、Jan（`:1337/v1`）、LocalAI（`:8080/v1`）、GPT4All
（`:4891/v1`）も同じように使えます。**WebBrain Companion** は、ローカルモデルと対応するアカウントの
サブスクリプションのための、別のデスクトップアプリです。[Windows、macOS、Linux 向けに
ダウンロード](https://github.com/webbrain-one/webbrain/releases/tag/systray-v0.1.2)したら、
**WebBrain Companion** のプロバイダーカードを選び、**モデルを読み込み** をクリックして、
モデルを選択し、接続をテストします。ローカルのエンドポイントのデフォルトは
`http://127.0.0.1:8327/v1` で、このコンピューター上では API キーは不要です。
[Companion のセットアップ](docs/providers-and-models.md#webbrain-companion)をご覧ください。
汎用の **Local OpenAI-compatible Proxy** のカードも、ほかの
OpenAI 互換のゲートウェイ向けに引き続き利用できます。
**Unsloth Studio (Local)** は、ユーザーが設定した Studio の
ポートと `sk-unsloth-` の API キーで、同じ OpenAI 互換の経路を使います。
[Unsloth Studio のセットアップ](docs/providers-and-models.md#unsloth-studio)をご覧ください。
**Osaurus (Local)** は、モデルの検出、ストリーミング、ツールの呼び出しに対応して、Mac の Osaurus サーバーに接続します。
[Osaurus のセットアップ](docs/providers-and-models.md#osaurus)をご覧ください。
読み込むコンテキストウィンドウのサイズは、選択したティアのシステムプロンプトとツールの
スキーマ、ページ/履歴、要求する出力に合わせて決めてください。**16k は設定上のフォールバックであり、
保証された最小値ではありません。Compact が 8k に収まることも保証されていません。**
Mid と Full は、履歴がたまる前でも 16k を超えることがあり、コンパクションでは
固定の指示やスキーマを縮められません。サイズの見積もりはモデルの
正確なトークナイザーによるものではありません。[コンテキストのガイダンス](docs/providers-and-models.md#local-providers)をご覧ください。
WebBrain は、llama.cpp、Ollama、LM Studio の実際のウィンドウを自動で検出し、
会話がいっぱいになるにつれて自動でコンパクションします。Ollama、
llama.cpp、LM Studio、LocalAI では、スクリーンショットを追加する前に、サーバーのネイティブのメタデータも読み取ります。
プロバイダーのページでは、自動、強制的にオン、オフで上書きできます。
モデル（任意）の欄が空の場合は、ユーザーのターンごとに読み込まれたモデルの能力を
再確認するため、サーバー側でのホットスワップが反映されます。また、
プレビュー版の `ollama launch webbrain --model <model>` の引き継ぎもあります。詳細：
[プロバイダーとモデル](docs/providers-and-models.md#local-providers)。

**クラウド API** — OpenAI、Anthropic Claude、Google Gemini、Azure OpenAI、AWS
Bedrock、Mistral、DeepSeek、xAI Grok、MiniMax、Kimi、Qwen、z.ai GLM、Groq、
Together、Cloudflare、Nvidia NIM、Hugging Face、Fireworks、OpenRouter など。
プロバイダーのページには、**Chromium では 119 の組み込みのプロバイダーカード**（Firefox では 118）があり、
テスト済みの LFM2.5 2.6B のプリセットを備えたエンドポイント不要のローカルの WebGPU の選択肢と、
実験的なカスタムの Hugging Face ONNX リポジトリの選択肢も含まれています。
[カタログの全体](docs/providers-and-models.md#extended-provider-catalog)をご覧ください。

ローカルのプロバイダーや、自分で用意したプロバイダーでは、プロバイダーごとの **研究のためにクエリを共有**
のスイッチは、引き続きデフォルトでオフです。有効にすると、既存のスクラブ済みのプロンプト/レスポンスの共有に加えて、
そのプロバイダーのモデルの試行（失敗した実行を含む）について、上限付きでコンテンツを含まない診断のタイムラインも
共有するようになりました。
タイムラインには、ツール名、結果、エラーコード、タイミングが含まれますが、
ツールの引数、ページのコンテンツ、スクリーンショットは含まれません。通常の
生成の共有の前に実行が失敗した場合は、上限付きのモデル向けのリクエストと最終的な障害が
診断の記録に付けられます。2 つ目の共有のスイッチは
必要ありません。既存のスイッチをオフにすると、キューに入った診断も削除されます。

## 機能

- **あらゆるページを読み取る** — テキスト、リンク、フォーム、表、PDF、インタラクティブな
  要素を、壊れやすいセレクターではなく、アクセシビリティツリーを通じて読み取ります
- **ページに対して操作する** — クリック、入力、スクロール、ナビゲーション、アップロード、ダウンロード、
  フォームの検証を行い、重要な操作の前にはサイトごとに許可を求めます
- **ビジョンモード**（別名「Tesla」モード） — カメラだけで走る Tesla のように、視覚だけを使います：画像を
  受け付けるモデルでは、Act の実行でページをスクリーンショットとして見て、座標でクリック、入力、スクロールします。各操作のあとには、
  画面の変化した部分だけが送信され、Retina ディスプレイやブラウザの
  ズームにも対応しています（[詳細](docs/vision-mode.md)）
- **Act の前に計画** — Act と Dev では、構造化された計画を生成して承認のために表示し、
  ツールを実行する前に、承認された計画をスクラッチパッドに固定できます
- **複数ステップのエージェント** — 自律的なツール使用のループで、最大 195 ステップまで設定できます
  （デフォルトは 130）。上限に達すると Continue ボタンが表示されます
- **保存されたワークフロー** — 成功した実行を、再利用可能で値を含まない
  ワークフローにして、再実行、エクスポート、共有できます
- **スケジュールされたタスクと監視** — `/schedule` であとで実行し、`/watch` で
  ページをポーリングして、条件を満たしたときに操作します
- **Skills** — 関連するときにだけ読み込まれる、信頼できる指示とツール
- **スマートなコンテキスト** — トークンを考慮した自動コンパクション、ツールの結果の制限、
  緊急時のオーバーフローからの復旧
- **タブごとの会話** — 各タブが独自の履歴を持ちます。明示した好みのための、オプションのローカルの
  ユーザーメモリーもあります
- **オプションのデバイス間の呼び出し** — OAuth で MemCode に接続して読み取り専用で
  参照できます。デフォルトはローカルのメモリーのままです（[セットアップとプライバシー](docs/memcode-recall.md)）
- **読むことを優先したサイドパネル** — ストリーミングされる Ask の返答、回答が長くなっても
  質問が見える位置に留まるフローティングのコントロール、コピーボタン、ページの検査の
  バナー、実行の途中でも効く停止ボタン
- **デフォルトで決定論的** — ブラウザの操作の判断には温度 `0.15`、
  Ask には `0.3`、ビジョンのスクリーンショットの説明には `0` を使います

## エージェントのツール

WebBrain は **ティア** と **モード** を分けています。ティア（`compact`、`mid`、`full`）は、
モデルに見せるツールの数を制御するプロバイダーごとの設定です。Compact は
小さなローカルモデルに適しており、Full ではホバー、ドラッグ＆ドロップ、フレーム、Shadow DOM が使えるようになります。モード
（`ask`、`act`、`dev`）は、ユーザーが何を許可しているかを制御します。

ティアごとのツールの完全な対応表、WebMCP についての注記、Dev モードの診断については、
[エージェントのツール](docs/agent-tools.md)をご覧ください。

## スラッシュコマンド

完全なシグネチャとフラグを見るには、パネルで `/help` と入力してください。特に便利なもの：

| コマンド                                                                                | 内容                                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/ask` · `/act` · `/dev` · `/plan`                                                     | 送信前にモードを切り替えます                                                  |
| `/schedule [prompt]`                                                                   | スケジュールされたタスクを作成します                                                     |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | 現在のページをポーリングし、条件を満たしたときに操作します                       |
| `/workflow` · `/workflow --save <name>`                                                | 保存されたワークフローを管理するか、最後に成功した実行をコンパイルします                   |
| `/teach --start <name>` · `/teach --end`                                               | 実際に操作してみせた内容から、再利用可能なワークフローを学習します                    |
| `/memory --add <text>`                                                                 | ユーザーの好みを保存します                                                      |
| `/screenshot [--full-page]`                                                            | タブ、またはスクロール可能なページ全体をキャプチャします                                |
| `/record [--transcribe]`                                                               | 現在のタブを録画し、必要に応じて書き起こしを保存します                      |
| `/export [--traces \| --config]`                                                       | 会話、ツールの連鎖、または設定のスナップショットをダウンロードします               |
| `/compact` · `/reset` · `/verbose`                                                     | コンテキストのコンパクション、会話の消去、ツールの詳細の表示切り替えを行います                 |
| `/allow-api`                                                                           | UI が失敗しているときに、`fetch_url` による変更を許可する、会話ごとの上書き |

`/watch` は最初のチェックをすぐに実行し、その後 60 秒ごとにポーリングします
（`--secs` には 30〜120 を指定できます）。「新しいコミットが現れたら」のような相対的な条件では、
最初のチェックで基準を決めます。`--keep` を付けると監視を続け、
同じ安定したイベントのキーに対する繰り返しの通知を抑えます。

`/dangerously-skip-permissions` や実行の記録用のサフィックスを含む完全なリファレンス：
[スラッシュコマンド](docs/slash-commands.md)。

## キーボードショートカット

Chrome のサイドパネルのショートカットは、WebBrain のサイドパネルにフォーカスがあるときに使えます。

| ショートカット                        | 内容                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Ctrl+/` または `Cmd+/`             | 入力欄にフォーカスします                                                              |
| `Ctrl+Shift+A` または `Cmd+Shift+A` | メッセージを `/ask` で始めます                                                |
| `Ctrl+Shift+X` または `Cmd+Shift+X` | メッセージを `/act` で始めます                                                |
| `Ctrl+Shift+D` または `Cmd+Shift+D` | メッセージを `/dev` で始めます                                                |
| `Escape`                        | 実行中の処理を停止します（スラッシュコマンドの補完を閉じるだけの場合を除きます） |
| `Escape` を 2 回                  | WebBrain やブラウザのページからの、進行中の録画を停止します                      |

## ドキュメント

|                                                                                                                          |                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [アーキテクチャ](docs/architecture.md)                                                                                     | システムの概要、ターンの流れ、サブシステム                   |
| [エージェントのツール](docs/agent-tools.md)                                                                                       | ティア、モード、ツールの完全な対応表                   |
| [スラッシュコマンド](docs/slash-commands.md)                                                                                 | すべてのコマンドとフラグ                                   |
| [プロバイダーとモデル](docs/providers-and-models.md)                                                                     | すべてのプロバイダーカード、ローカルのセットアップ、ティア                   |
| [Skills](docs/skills.md)                                                                                                 | 同梱のスキル、インポート、スキルのツール                   |
| [セキュリティモデル](docs/security-model.md)                                                                                 | 権限、認証情報、信頼の境界               |
| [Cloud Bridge の承認](docs/cloud-bridge-browser-approval.md)                                                           | バックエンドのための、オプトインのブラウザの登録と承認    |
| [プロンプトインジェクションへの防御](docs/prompt-injection-defense.md)                                                             | 防御のレイヤーと既知の欠落                            |
| [プライバシーとデータの流れ](docs/privacy-and-data-flow.md)                                                                   | 何がブラウザの外に出て、何が出ないか                |
| [アクセシビリティツリーと参照](docs/accessibility-tree-and-refs.md)                                                       | ページをどう読み取り、どう対象を指定するか                          |
| [サイトアダプター](docs/site-adapters.md)                                                                                   | サイトごとのガイダンスと、バージョン管理されたワークフローの契約       |
| [エクスポートとワークフローの形式](docs/export-and-workflow-formats.md)                                                       | `webbrain-config/1`、`webbrain-workflow/1`               |
| [ツールの追加](docs/adding-a-tool.md) · [ローカライズ](docs/localization.md) · [テストシナリオ](docs/test-scenarios.md) | コントリビューター向けのガイド                                       |
| [コミュニティ](docs/community.md)                                                                                           | Discord サーバーのガイド：チャンネル、ロール、ルール、エスカレーション |

[中文](docs/zh-CN/) と [Français](docs/fr/) でもご覧いただけます。

## コミュニティ

ヘルプ、ローカルとクラウドのモデルのセットアップ、サイトアダプター、作品の紹介、コントリビューター間の調整など、
WebBrain に関するあらゆることを、[WebBrain の Discord](https://discord.gg/cgC325ssfw) で話し合いましょう。
サーバーの構成については[コミュニティ](docs/community.md)を、
チャンネル、ロール、ウェルカム画面の設定については [discord-setup](docs/discord-setup.md) を
ご覧ください。バグの報告と機能のリクエストは、Discord ではなく
[GitHub の Issue](https://github.com/webbrain-one/webbrain/issues) にお願いします。

## リポジトリの構成

```
src/chrome/     Manifest V3 build — service worker, chrome.scripting, sidePanel
src/firefox/    Manifest V2 build — background page, executeScript, sidebar_action
docs/           Design and reference docs (en, zh-CN, fr)
mcp-server/     MCP server — delegate browser tasks from Claude Code, Codex, Cursor
lmstudio-plugin/  Web tools + browser delegation as a standalone LM Studio plugin
web/            Landing site and docs site
test/           Node test suite, LLM scenario benchmarks, security corpora
```

エージェントのコードは、ほぼすべてが 2 つのビルドで共有されています。どこで違いがあるかについては、
[アーキテクチャ](docs/architecture.md#chrome-vs-firefox-key-differences)を
ご覧ください。

## 既知の問題

**Firefox は Chrome よりも明らかに機能が劣ります。** Firefox には、`chrome.debugger` を通じた
Chrome DevTools Protocol に相当するものがないため、Firefox のビルドには、
Shadow DOM の貫通、本物の信頼されたマウスイベント（一部の React/Vue のハンドラーが
発火しません）、閉じた Shadow Root の走査、`resolveSelector` のリトライの予算、
SPA のナビゲーションを考慮したリトライ、CDP のスクリーンショットがありません。ビューポートのスクリーンショットには、
非アクティブな実行のタブも含めて `tabs.captureTab` を使いますが、
Chrome のピクセル単位で正確なキャプチャや、ページ全体の CDP のキャプチャは引き続き提供できません。サイトアダプター、ビジョンの
検出、ループの検出、自動スクリーンショットのループ、Compact のプロンプト/ツールの
セットは、Firefox にも反映 _されています_。一部のシングルページアプリでは、
クライアント側のナビゲーションのあとで、コンテンツスクリプトの再注入が起きないこともあります。

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。ツールを追加するには、
[ツールの追加](docs/adding-a-tool.md)のチェックリストに従ってください。プロバイダーを追加するには、
`BaseLLMProvider` を継承し、`chat()`（必要に応じて `chatStream()` も）を実装して、
`providers/manager.js` に登録します。その際、両方の変更を
`src/chrome/` と `src/firefox/` に反映してください。すべてのプロバイダーは
`{ content, toolCalls, usage }` に正規化されます。詳細は
[プロバイダーとモデル](docs/providers-and-models.md#adding-a-provider)をご覧ください。

最近の変更は [CHANGELOG.md](CHANGELOG.md) にあります。

## MCP サーバー

コーディングエージェントに、*あなたの* ブラウザを使わせましょう。Claude Code、Codex、Cursor、OpenClaw は、
すでにサインインしているセッションで動作する WebBrain にタスクを任せられます。
Cookie はそろっていて、SSO もすでに通過しています。ヘッドレスのフレームワークはログアウトした状態で始まり、
最初のログインの壁で止まってしまいますが、これはそうなりません。

```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

Claude Code は、MCP のセッションを開始するときに、サーバーを自動的に起動します。
代わりに自分で起動するには、次のコマンドを実行し、そのターミナルを
開いたままにしてください（停止するには `Ctrl+C` を押します）：

```bash
npx -y @webbrain/mcp-server
```

サーバーが起動したら、**WebBrain → 設定 → ブリッジ（Bridge）** を開き、
URL を `ws://127.0.0.1:17374/extension` に設定し、
`npx -y @webbrain/mcp-server pairing-key` が表示したペアリングキーを **ペアリングキー（Pairing key）** に貼り付けて、有効にします。
サーバーは、そのキーを持っていることを証明したソケットだけを信頼します（新しいチャレンジに対する HMAC で、
キー自体が送信されることはありません）。そのため、ほかのローカルのプロセスが拡張機能になりすますことはできません。
LM Studio のプラグインも、同じキーファイル
`~/.webbrain/bridge-key` を使います。サーバーをアップグレードする前に、拡張機能を更新してください：
ペアリングキーの欄がないバージョンではペアリングできません。
Chromium 系のブラウザでは、ブリッジは拡張機能のオフスクリーンドキュメントから動作します。
Firefox では、バックグラウンドページでホストされ、同じ
**設定 → ブリッジ** タブで設定します（実際の Firefox のインストールで MCP サーバーとの組み合わせはまだ
検証していません）。コマンドを送る前に各ブラウザを承認する必要があるバックエンドでは、
[Cloud Bridge のブラウザの承認](docs/cloud-bridge-browser-approval.md)で説明している
オプトインのトークンのハンドシェイクを使えます。

設定に **接続エラー: WebSocket error** と表示される場合は、通常、設定した URL で
何も待ち受けていません。MCP サーバーを起動し、URL が
ポート `17374` を使っていることを確認して、そのプロセスを実行したままにしてください。
待ち受けの確認方法とほかのブリッジのポートについては、
[`mcp-server` のトラブルシューティングガイド](mcp-server/README.md#troubleshooting)をご覧ください。

```
webbrain_run(task: "open the Stripe dashboard and list last week's failed
             payments with amounts and customer emails", mode: "ask")
```

呼び出し側が、散文の要約ではなく予測可能な構造化された出力を必要とする場合は、
JSON Schema とともに `webbrain_extract` を使ってください。サーバーは、タスク単位の 6 つの
ツールを公開しています：実行、構造化された抽出、状態、確認への応答、中止、
接続の診断です。

`mode='ask'` は読み取り専用です。`mode='act'` ではクリックや入力ができ、人間に出るのと同じ
ブラウザ内の承認のプロンプトで制御されます。サーバーが公開しているのはタスクの委任であり、
約 50 の低レベルのブラウザのプリミティブではありません：WebBrain の権限のゲートは
エージェントのループの中にあるため、ソケット経由でプリミティブ単位にアクセスできるようにすると、
ゲートの下を通ってそれを迂回してしまうからです。詳細は [`mcp-server/`](mcp-server/) をご覧ください。

クライアントの完全なセットアップ、ツールの引数、実行のライフサイクル、構造化された出力の
例、安全の境界、トラブルシューティングのガイドは、
[`web/docs/mcp/`](web/docs/mcp/) にあります。

> 拡張機能が一度に保持するブリッジのソケットは **1 つ** だけです：WebBrain Cloud（17373）、
> MCP サーバー（17374）、または LM Studio のプラグイン（17375）。切り替えるには、
> **設定 → ブリッジ** で URL を変更してください。

## LM Studio プラグイン

[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools) にある、
単独の [LM Studio](https://lmstudio.ai) プラグインです：

```bash
lms clone webbrain/web-tools
```

`fetch_url` と `research_url` は純粋な Node の HTTP です。ブラウザは不要ですが、
Cookie もセッションも JavaScript もありません。Chromium 系のブラウザに拡張機能をインストールしていれば、
`browser_task` によって、実際にサインインしているブラウザへの委任が加わり、
単純な HTTP では届かない、認証が必要なページやクライアント側でレンダリングされるページにも到達できます。
拡張機能が接続されていない場合は、対処方法を示すメッセージとともに機能を縮退させ、HTTP の
ツールは Firefox でも引き続き動作します。

ソース：[`lmstudio-plugin/`](lmstudio-plugin/)。


## コントリビューター

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## 引用

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: Open-source AI browser agent for chatting with pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## ライセンス

WebBrain は
[GPL-3.0-or-later](LICENSE) のもとでライセンスされています。配布されているブラウザの拡張機能が、
GPL ライセンスの Xapian/libzim の WebAssembly ランタイムを同梱し、統合しているためです。

[Emre Sokullu](https://emresokullu.com) と[オープンソースのコントリビューター](https://github.com/webbrain-one/webbrain/graphs/contributors)が ❤️ を込めて作りました。
