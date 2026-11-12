# EasyCLIProxy tutorial — pickup shot for the new Settings layout

`web/docs/assets/media/easy-cli-proxy-tutorial.mp4` (English) and `easy-cli-proxy-tutorial.zh-CN.mp4` (Chinese) are still right except for about ten seconds: from 1:09.7 to 1:20.4 in the English cut (1:10.1 to 1:19.6 in the Chinese one), the video opens Settings and searches the old **Providers** tab. Since the one-page Settings layout, provider cards are under **Models → LLM** in the Settings sidebar.

Re-record only that segment and splice it in. Everything before it (EasyCLIProxy's OAuth and endpoint) and after it (pasting the URL and key, Load Models, the vision and prompt-tier settings, the Ask and Act tests) shows no WebBrain Settings chrome that changed.

## The shot

1. **Start** on the WebBrain side panel, the same framing as the cut before 1:09.
2. Open the model menu and choose **More…**. Settings opens on **Models → LLM**.
   (Alternative: click the gear, then **LLM** under **Models** in the sidebar. More… is shorter and is what the guide's text describes.)
3. Click the search field above the provider list and type `Local OpenAI`.
4. **End** with the **Local OpenAI-compatible Proxy** card expanded and its Server URL field in view, the same framing the next cut starts from (pasting the URL).

Use a clean profile: no real keys on screen, and no other provider expanded.

## Captions

Replace these cues. Keep the start of the first cue and the end of the second, and adjust both to the new cut's timing.

English (`easy-cli-proxy-tutorial.en.vtt`), replacing the cues at 00:01:09.733 and 00:01:15.100:

```
00:01:09.733 --> 00:01:15.100
Next, switch over to WebBrain, open the model menu
and choose More… to open its model settings.

00:01:15.100 --> 00:01:20.400
Under Models → LLM, search for the “Local
OpenAI-compatible Proxy” option.
```

Chinese (`easy-cli-proxy-tutorial.zh-CN.vtt`), replacing the cues at 00:01:10.140 and 00:01:14.330:

```
00:01:10.140 --> 00:01:14.330
接下来切换到 WebBrain，打开模型菜单并选择“更多…”，进入模型设置。

00:01:14.330 --> 00:01:19.600
在“模型 → LLM”中，搜索“本地 OpenAI 兼容代理”。
```

"更多…" is the side panel's own label for More… in Chinese (`sp.providers.more` in `src/chrome/src/ui/locales/zh.js`).

## After the new cut is in

- Replace both `.mp4` files and, if the first frame changed, `easy-cli-proxy-poster.webp`.
- Update the two `.vtt` files as above.
- `test/run.js` checks the media files and the guide's player markup ("public EasyCLIProxy guide …" tests); run it after replacing them.
