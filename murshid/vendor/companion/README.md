# WebBrain Companion builds for packaging

Put a WebBrain Companion build for each target in `vendor/companion/<platform>-<arch>/`
(for example `win32-x64/WebBrainCompanion.exe`, `darwin-x64/WebBrain Companion.app`,
`linux-x64/webbrain-companion`). `npm run dist` bundles that folder as `resources/companion`,
and Murshid starts it from there. Build it from `../webbrain-systray` with `scripts/build.sh`.

For a universal macOS build, put the universal app in both `darwin-x64` and
`darwin-arm64`: electron-builder packages each architecture before merging them.

The binaries are not committed.
