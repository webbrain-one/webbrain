# Apocalypse Mode promo — pickup shot for the new Settings layout

`web/assets/apocalypse-mode.mp4` (the "Introducing Apocalypse Mode" video in the landing page popup, about 55 seconds) shows WebBrain Settings for about two seconds, at roughly 0:11–0:13. That shot is from an old version (v32, with the General / Providers / Multimodal / Memory / Skills / Permissions tab strip), and it opens Apocalypse Mode from a link in the Settings header. That link no longer exists: Apocalypse Mode is now the **Offline** section of the Settings sidebar.

The rest of the video shows only the Apocalypse Mode page, Emergency Box, the offline Wikipedia reader and the side panel, which this change did not touch. Sampling was one frame per second from 0:06 to 0:20 and one every six seconds after that.

## The shot

1. **Start** on WebBrain Settings with the sidebar visible, the same framing and zoom as the old shot.
2. Click **Offline** in the sidebar. The section shows the status line ("Off · no offline archive will be used." on a fresh profile).
3. Click **Open Apocalypse Mode**. Apocalypse Mode opens in a new tab.
4. **End** on the Apocalypse Mode page header, the frame the next cut starts from.

Keep it as short as the original (about two seconds): the click on Offline and the click on the button can be one continuous move. Settings reopens on the last section you used, so open General once before recording, and use a profile with no real provider keys.

## After the new cut is in

Replace `web/assets/apocalypse-mode.mp4` and keep the same file name, so the landing page popup (`web/build/template.html`) needs no change.
