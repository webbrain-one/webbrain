"""Unit-style tests for the v4 SMD additions: AES-128 HLS decryption,
the MSE/SourceBuffer recorder, and the YouTube progressive parser.

These tests do NOT need a real social-media login — each one uses
Playwright's request interception (page.route) to mock the fetches the
script makes, or synthesizes browser objects directly. That means they
run reliably from CI / a clean profile without depending on whether a
particular video is still up on Facebook today.
"""
from __future__ import annotations
import time
from common import TestResult, inject_smd
from sites import _safe_goto, _screenshot

TESTS = []

def register(fn):
    TESTS.append(fn)
    return fn


# ─────────────────────────────────────────────────────────────────────
# AES-128 HLS decryption
# ─────────────────────────────────────────────────────────────────────
@register
def test_hls_aes128_decryption(page, js_path, sdir):
    """Synthesize an AES-128-CBC encrypted single-segment HLS playlist,
    mock all fetches, and assert SMD._stitchHls() returns the plaintext.
    """
    r = TestResult(site="hls_aes128_decryption",
                   url="https://fixture-hls.test/", passed=False)

    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives import padding
    except ImportError:
        r.error = "cryptography library missing (pip install cryptography)"
        r.notes = "skipped: install cryptography to enable"
        return r

    # Fixed test vectors so the assertion is reproducible.
    key = bytes(range(1, 17))                                     # 16-byte key
    iv = bytes(range(17, 33))                                     # 16-byte IV
    plaintext = (b"the quick brown fox jumps over the lazy dog. "
                 b"1234567890" * 4)                               # ~ 220 bytes
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = cipher.update(padded) + cipher.finalize()

    m3u8 = (
        "#EXTM3U\n"
        "#EXT-X-VERSION:3\n"
        "#EXT-X-TARGETDURATION:6\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n"
        f'#EXT-X-KEY:METHOD=AES-128,URI="https://fixture-hls.test/key.bin",IV=0x{iv.hex()}\n'
        "#EXTINF:6.0,\n"
        "https://fixture-hls.test/seg0.ts\n"
        "#EXT-X-ENDLIST\n"
    )

    def route_handler(route):
        u = route.request.url
        # Permissive CORS so credentials:'include' fetches work either way.
        h = {"access-control-allow-origin": "*",
             "access-control-allow-credentials": "true"}
        if u.endswith("/playlist.m3u8"):
            route.fulfill(body=m3u8,
                          content_type="application/vnd.apple.mpegurl",
                          headers=h)
        elif u.endswith("/key.bin"):
            route.fulfill(body=key,
                          content_type="application/octet-stream",
                          headers=h)
        elif u.endswith("/seg0.ts"):
            route.fulfill(body=ciphertext,
                          content_type="video/mp2t",
                          headers=h)
        else:
            route.fulfill(body="<!doctype html><html><body></body></html>",
                          content_type="text/html", headers=h)

    pattern = "https://fixture-hls.test/**"
    page.route(pattern, route_handler)
    try:
        _safe_goto(page, "https://fixture-hls.test/", timeout_ms=10000)
        inject_smd(page, js_path)
        result = page.evaluate(
            """async () => {
                try {
                    const blob = await SocialMediaDownloader._stitchHls(
                        'https://fixture-hls.test/playlist.m3u8'
                    );
                    const buf = await blob.arrayBuffer();
                    return { ok: true, bytes: Array.from(new Uint8Array(buf)) };
                } catch (e) {
                    return { ok: false, error: String(e && e.message || e) };
                }
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    if not result.get("ok"):
        r.error = f"_stitchHls threw: {result.get('error')}"
        r.screenshot_path = _screenshot(page, sdir, "hls_aes128_decryption")
        return r

    decrypted = bytes(result["bytes"])
    r.url_count = len(decrypted)
    r.sample_urls = [f"decrypted[:32] = {decrypted[:32]!r}"]
    r.assertions = [
        f"decrypted length == {len(plaintext)} (got: {len(decrypted)})",
        "decrypted bytes match plaintext exactly",
    ]
    if decrypted != plaintext:
        r.failures.append(
            f"decrypted mismatch (first 32: got {decrypted[:32]!r}, "
            f"want {plaintext[:32]!r})"
        )
    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "hls_aes128_decryption")
    return r


# ─────────────────────────────────────────────────────────────────────
# MSE / SourceBuffer recorder
# ─────────────────────────────────────────────────────────────────────
@register
def test_mse_recorder(page, js_path, sdir):
    """Arm the MSE recorder, then create a MediaSource + SourceBuffer
    programmatically and feed it a few bytes via appendBuffer. The hook
    must record those bytes regardless of whether the MP4 parser accepts
    them (which it won't — they're not a valid init segment)."""
    r = TestResult(site="mse_recorder",
                   url="https://fixture-mse.test/", passed=False)

    pattern = "https://fixture-mse.test/**"
    page.route(pattern, lambda route: route.fulfill(
        body="<!doctype html><html><body></body></html>",
        content_type="text/html",
        headers={"access-control-allow-origin": "*"}))
    try:
        _safe_goto(page, "https://fixture-mse.test/", timeout_ms=10000)
        inject_smd(page, js_path)
        result = page.evaluate(
            """async () => {
                // Reset any captured state from a previous test on the same
                // page object — patches survive across SMD re-injections.
                delete window.__smd_mse;

                const arm = SocialMediaDownloader.armMseRecorder();
                if (!arm.armed) {
                    return { ok: false, error: 'arm failed: ' + (arm.error || 'unknown') };
                }

                if (typeof MediaSource === 'undefined') {
                    return { ok: false, error: 'MediaSource unavailable in this browser' };
                }

                const ms = new MediaSource();
                const url = URL.createObjectURL(ms);
                const video = document.createElement('video');
                video.muted = true;
                document.body.appendChild(video);

                await new Promise((resolve, reject) => {
                    const t = setTimeout(() => reject(new Error('sourceopen timeout')), 5000);
                    ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
                    video.src = url;
                });

                const mime = 'video/mp4; codecs="avc1.42E01E"';
                const sb = ms.addSourceBuffer(mime);

                const payload = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12]);
                // Invalid MP4 → parser will fire 'error' shortly after. Our
                // hook runs synchronously BEFORE the parser, so the bytes
                // are captured even though the buffer never plays.
                try { sb.appendBuffer(payload); } catch (e) {}
                // Give the parser a tick to settle so the test isn't racing
                // an in-flight 'updating' state on teardown.
                await new Promise(r => setTimeout(r, 250));

                return {
                    ok: true,
                    recording: SocialMediaDownloader.getMseRecording(),
                    blobUrlSeen: url.startsWith('blob:'),
                };
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    if not result.get("ok"):
        r.error = result.get("error")
        r.screenshot_path = _screenshot(page, sdir, "mse_recorder")
        return r

    rec = result["recording"]
    captured_bytes = 0
    captured_mimes = []
    for ms in rec.get("mediaSources", []):
        for buf in ms.get("buffers", []):
            captured_bytes += buf.get("bytes", 0)
            if buf.get("mime"): captured_mimes.append(buf["mime"])
    for orphan in rec.get("orphanBuffers", []):
        captured_bytes += orphan.get("bytes", 0)

    r.url_count = captured_bytes
    r.sample_urls = [
        f"armed = {rec.get('armed')}",
        f"mediaSources = {len(rec.get('mediaSources', []))}",
        f"orphanBuffers = {len(rec.get('orphanBuffers', []))}",
        f"mimes = {captured_mimes[:3]}",
    ]
    r.assertions = [
        f"armed == True (got: {rec.get('armed')})",
        f"at least one MediaSource tracked (got: {len(rec.get('mediaSources', []))})",
        f"captured bytes >= 12 (got: {captured_bytes})",
        f"blob: URL recorded (got: {result.get('blobUrlSeen')})",
    ]
    if not rec.get("armed"):
        r.failures.append("recorder did not arm")
    if len(rec.get("mediaSources", [])) < 1:
        r.failures.append("MediaSource not tracked via URL.createObjectURL hook")
    if captured_bytes < 12:
        r.failures.append(f"appendBuffer hook captured only {captured_bytes} bytes (expected 12)")
    if not any("video/mp4" in m for m in captured_mimes):
        r.failures.append("MIME type 'video/mp4' not recorded from addSourceBuffer")
    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "mse_recorder")
    return r


# ─────────────────────────────────────────────────────────────────────
# Auto-arm at load: the SMD prelude (registered as a document_start
# content_script in MAIN world on social hosts) should call
# armMseRecorder() automatically when location.hostname matches the
# auto-arm list — no manual arm needed.
# ─────────────────────────────────────────────────────────────────────
@register
def test_mse_autoarm_on_social_host(page, js_path, sdir):
    """Inject SMD on a host that matches the auto-arm regex (we route a
    fake `*.facebook.com` so the navigation stays offline) and assert
    that the recorder is armed and the prototype patches are flagged,
    without the test ever calling armMseRecorder() itself.
    """
    r = TestResult(site="mse_autoarm_on_social_host",
                   url="https://fixture.facebook.com/", passed=False)

    pattern = "https://fixture.facebook.com/**"
    page.route(pattern, lambda route: route.fulfill(
        body="<!doctype html><html><body></body></html>",
        content_type="text/html",
        headers={"access-control-allow-origin": "*"}))
    try:
        # Wipe any state carried from earlier tests on the same page.
        try:
            page.evaluate("() => { delete window.__smd_mse; delete window.__smd_logged; }")
        except Exception:
            pass
        _safe_goto(page, "https://fixture.facebook.com/", timeout_ms=10000)
        inject_smd(page, js_path)
        result = page.evaluate(
            """() => {
                const armed = !!(window.__smd_mse && window.__smd_mse.armed);
                const sbPatched = !!(
                    typeof SourceBuffer !== 'undefined' &&
                    SourceBuffer.prototype.appendBuffer &&
                    SourceBuffer.prototype.appendBuffer.__smd_patched
                );
                const msPatched = !!(
                    typeof MediaSource !== 'undefined' &&
                    MediaSource.prototype.addSourceBuffer &&
                    MediaSource.prototype.addSourceBuffer.__smd_patched
                );
                return { armed, sbPatched, msPatched, host: location.hostname };
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    r.url_count = (1 if result.get("armed") else 0)
    r.sample_urls = [f"host = {result.get('host')}", f"armed = {result.get('armed')}",
                     f"sbPatched = {result.get('sbPatched')}",
                     f"msPatched = {result.get('msPatched')}"]
    r.assertions = [
        f"host matches auto-arm regex (got: {result.get('host')})",
        f"window.__smd_mse.armed == true (got: {result.get('armed')})",
        f"SourceBuffer.prototype.appendBuffer is __smd_patched (got: {result.get('sbPatched')})",
        f"MediaSource.prototype.addSourceBuffer is __smd_patched (got: {result.get('msPatched')})",
    ]
    if not result.get("armed"):
        r.failures.append("auto-arm did NOT fire on a facebook.com host")
    if not result.get("sbPatched"):
        r.failures.append("SourceBuffer.appendBuffer not patched")
    if not result.get("msPatched"):
        r.failures.append("MediaSource.addSourceBuffer not patched")
    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "mse_autoarm_on_social_host")
    return r


@register
def test_mse_noautoarm_off_social_host(page, js_path, sdir):
    """The reverse: on a non-social host (e.g. example.com), SMD should
    NOT auto-arm. The patches and state should only appear if a tool /
    user calls armMseRecorder() explicitly. Catches regressions where
    the regex accidentally matches too widely."""
    r = TestResult(site="mse_noautoarm_off_social_host",
                   url="https://fixture-neutral.test/", passed=False)
    pattern = "https://fixture-neutral.test/**"
    page.route(pattern, lambda route: route.fulfill(
        body="<!doctype html><html><body></body></html>",
        content_type="text/html",
        headers={"access-control-allow-origin": "*"}))
    try:
        try:
            page.evaluate("() => { delete window.__smd_mse; delete window.__smd_logged; }")
        except Exception:
            pass
        _safe_goto(page, "https://fixture-neutral.test/", timeout_ms=10000)
        inject_smd(page, js_path)
        result = page.evaluate(
            """() => {
                return {
                    host: location.hostname,
                    mseStateExists: typeof window.__smd_mse !== 'undefined',
                    armed: !!(window.__smd_mse && window.__smd_mse.armed),
                };
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    r.url_count = (0 if not result.get("armed") else 1)
    r.sample_urls = [f"host = {result.get('host')}",
                     f"mseStateExists = {result.get('mseStateExists')}",
                     f"armed = {result.get('armed')}"]
    r.assertions = [
        f"host does NOT match auto-arm regex (got: {result.get('host')})",
        f"recorder did NOT auto-arm (got armed: {result.get('armed')})",
    ]
    if result.get("armed"):
        r.failures.append("auto-arm fired on a NON-social host (regex too greedy?)")
    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "mse_noautoarm_off_social_host")
    return r


# ─────────────────────────────────────────────────────────────────────
# Recommendation builder — purely functional; verify every branch.
# Drives all five `kind` values from synthetic inputs so we don't need a
# real DRM'd YouTube, a real MSE-locked Facebook video, etc.
# ─────────────────────────────────────────────────────────────────────
@register
def test_recommendation_builder(page, js_path, sdir):
    r = TestResult(site="recommendation_builder",
                   url="https://fixture-rec.test/", passed=False)
    pattern = "https://fixture-rec.test/**"
    page.route(pattern, lambda route: route.fulfill(
        body="<!doctype html><html><body></body></html>",
        content_type="text/html",
        headers={"access-control-allow-origin": "*"}))
    try:
        _safe_goto(page, "https://fixture-rec.test/", timeout_ms=10000)
        inject_smd(page, js_path)
        out = page.evaluate(
            """() => {
                const b = SocialMediaDownloader._buildRecommendation;

                // 1. YouTube watch page with only thumbnail URLs → yt-dlp pitch
                const r1 = b({
                    profile: 'youtube',
                    urls: ['https://i.ytimg.com/vi/abc/maxresdefault.jpg'],
                    mseBytes: 0,
                    pageUrl: 'https://www.youtube.com/watch?v=abc',
                });

                // 2. MSE recorder has captured bytes → tell agent to saveMse()
                const r2 = b({
                    profile: 'facebook',
                    urls: ['https://video.fbcdn.net/x/blah.mp4'],
                    mseBytes: 1048576,
                    pageUrl: 'https://www.facebook.com/watch/?v=123',
                });

                // 3. blob: URL seen but no captured bytes → reload+play pitch
                const r3 = b({
                    profile: 'instagram',
                    urls: ['blob:https://www.instagram.com/abc-123'],
                    mseBytes: 0,
                    pageUrl: 'https://www.instagram.com/reel/xyz/',
                });

                // 4. Generic profile (unsupported site) → both tools
                const r4 = b({
                    profile: 'generic',
                    urls: ['https://random.example.com/image.jpg'],
                    mseBytes: 0,
                    pageUrl: 'https://random.example.com/post/1',
                });

                // 5. Supported site but no URLs at all → empty_result
                const r5 = b({
                    profile: 'pinterest',
                    urls: [],
                    mseBytes: 0,
                    pageUrl: 'https://www.pinterest.com/me/',
                });

                // 6. Healthy case (YouTube watch with a googlevideo URL) → no rec
                const r6 = b({
                    profile: 'youtube',
                    urls: ['https://rr1---sn-foo.googlevideo.com/video.mp4?abc'],
                    mseBytes: 0,
                    completedCount: 1,
                    completedVideoCount: 1,
                    pageUrl: 'https://www.youtube.com/watch?v=abc',
                });

                // 7. Healthy non-YT case (Pinterest with pinimg URLs) → no rec
                const r7 = b({
                    profile: 'pinterest',
                    urls: ['https://i.pinimg.com/originals/foo.jpg'],
                    mseBytes: 0,
                    pageUrl: 'https://www.pinterest.com/pin/123/',
                });

                // 8. A completed YouTube thumbnail is not a completed video.
                const r8 = b({
                    profile: 'youtube',
                    urls: ['https://i.ytimg.com/vi/abc/maxresdefault.jpg'],
                    mseBytes: 0,
                    completedCount: 1,
                    completedVideoCount: 0,
                    pageUrl: 'https://www.youtube.com/watch?v=abc',
                });

                return [r1, r2, r3, r4, r5, r6, r7, r8];
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    r.url_count = sum(1 for x in (out or []) if x)
    r.sample_urls = [f"r{i+1}.kind = {x.get('kind') if x else 'null'}" for i, x in enumerate(out or [])]
    r.assertions = [
        "r1.kind == 'youtube_video' (DRM/cipher fallback)",
        "r2.kind == 'mse_capture_available' (captured bytes)",
        "r3.kind == 'mse_capture_empty' (blob with no buffer)",
        "r4.kind == 'unsupported_site' (generic profile)",
        "r5.kind == 'empty_result' (supported site, no URLs)",
        "r6 == null (YT with progressive URL — healthy)",
        "r7 == null (Pinterest with originals URL — healthy)",
        "r8.kind == 'youtube_video' (thumbnail completion is not video success)",
    ]
    exp = ['youtube_video', 'mse_capture_available', 'mse_capture_empty',
           'unsupported_site', 'empty_result', None, None, 'youtube_video']
    for i, expected in enumerate(exp):
        actual = (out[i] or {}).get('kind') if out and out[i] else None
        if actual != expected:
            r.failures.append(f"r{i+1}: expected kind={expected!r}, got {actual!r}")

    # Spot-check that each non-null message includes the right CLI hint.
    if out and out[0] and 'yt-dlp' not in out[0].get('message', ''):
        r.failures.append("r1 message doesn't mention yt-dlp")
    if out and out[2] and 'yt-dlp' not in out[2].get('message', ''):
        r.failures.append("r3 message doesn't mention yt-dlp")
    if out and out[3] and ('yt-dlp' not in out[3].get('message', '')
                            or 'gallery-dl' not in out[3].get('message', '')):
        r.failures.append("r4 message doesn't mention BOTH yt-dlp and gallery-dl")
    if out and out[1] and 'saveMse' not in out[1].get('message', ''):
        r.failures.append("r2 message doesn't mention saveMse()")

    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "recommendation_builder")
    return r


# ─────────────────────────────────────────────────────────────────────
# YouTube progressive-format parser
# ─────────────────────────────────────────────────────────────────────
@register
def test_youtube_progressive_parser(page, js_path, sdir):
    """Verify the parser surfaces pre-signed progressive URLs from
    ytInitialPlayerResponse and skips signatureCipher entries. Runs on a
    routed fixture host (NOT www.youtube.com) so CDP-attached Chromes
    don't accidentally hit the real YouTube and pollute the test —
    we set window.ytInitialPlayerResponse directly to a known shape.
    The HTML-parser fallback is verified in a second pass that strips
    the window var and writes the JSON into document.documentElement.
    """
    r = TestResult(site="youtube_progressive_parser",
                   url="https://yt-fixture.test/", passed=False)

    pattern = "https://yt-fixture.test/**"
    page.route(pattern, lambda route: route.fulfill(
        body="<!doctype html><html><head></head><body></body></html>",
        content_type="text/html",
        headers={"access-control-allow-origin": "*"}))
    try:
        _safe_goto(page, "https://yt-fixture.test/", timeout_ms=10000)
        inject_smd(page, js_path)

        # Pass 1 — window.ytInitialPlayerResponse path.
        urls_via_window = page.evaluate(
            """() => {
                window.ytInitialPlayerResponse = {
                    streamingData: {
                        formats: [
                            { itag: 18,
                              url: 'https://example.googlevideo.com/video.mp4?signature=abc',
                              mimeType: 'video/mp4' }
                        ],
                        adaptiveFormats: [
                            { itag: 137,
                              signatureCipher: 's=encoded_signature_value&url=https://example.googlevideo.com/cipher.mp4',
                              mimeType: 'video/mp4' },
                            { itag: 140,
                              url: 'https://example.googlevideo.com/audio.m4a?signature=xyz',
                              mimeType: 'audio/mp4' }
                        ]
                    }
                };
                return SocialMediaDownloader._extractYoutubeProgressive();
            }"""
        )

        # Pass 2 — HTML fallback. Strip the window var, dump the JSON
        # inline as a literal in the document, and re-call the parser.
        # `_findJsonObject` should walk balanced braces in innerHTML and
        # JSON.parse the result.
        urls_via_html = page.evaluate(
            """() => {
                delete window.ytInitialPlayerResponse;
                const json = {
                    streamingData: {
                        formats: [
                            { itag: 22,
                              url: 'https://example.googlevideo.com/html-path.mp4?signature=def',
                              mimeType: 'video/mp4' }
                        ]
                    }
                };
                document.body.innerHTML =
                    '<!-- ytInitialPlayerResponse = ' + JSON.stringify(json) + ' -->';
                return SocialMediaDownloader._extractYoutubeProgressive();
            }"""
        )
    finally:
        try: page.unroute(pattern)
        except Exception: pass

    urls1 = urls_via_window or []
    urls2 = urls_via_html or []
    r.url_count = len(urls1) + len(urls2)
    r.sample_urls = (urls1 + urls2)[:5]
    r.assertions = [
        f"window-path: progressive video URL extracted (got: {len(urls1)})",
        "window-path: direct audio URL extracted",
        "window-path: signatureCipher format SKIPPED",
        f"html-fallback path: parser walks innerHTML JSON (got: {len(urls2)})",
    ]
    if not any("video.mp4" in u for u in urls1):
        r.failures.append("window-path: progressive 'formats[0].url' not extracted")
    if not any("audio.m4a" in u for u in urls1):
        r.failures.append("window-path: adaptive 'audio.m4a' direct URL not extracted")
    if any("encoded_signature_value" in u for u in urls1):
        r.failures.append("window-path: signatureCipher format leaked (should be skipped)")
    if not any("html-path.mp4" in u for u in urls2):
        r.failures.append("html-fallback: didn't extract URL from balanced-brace JSON in innerHTML")
    r.passed = not r.failures
    if not r.passed:
        r.screenshot_path = _screenshot(page, sdir, "youtube_progressive_parser")
    return r
