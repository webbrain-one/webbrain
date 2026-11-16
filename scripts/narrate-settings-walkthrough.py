#!/usr/bin/env python3
"""Generate the settings walkthrough voiceover and timed captions.

Requires Python 3.11+, the optional authoring dependency edge-tts, and ffprobe.
Uses Microsoft's online Edge speech service; only the public narration is sent.
No browser profile, extension state, credentials, or user data are read.

Run: py -3.11 scripts/narrate-settings-walkthrough.py
"""

import argparse
import asyncio
import hashlib
import html
import json
from pathlib import Path
import subprocess

import edge_tts


ROOT = Path(__file__).resolve().parents[1]


def timestamp(seconds):
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def captions(words):
    """Keep captions short, preferring sentence ends and actual word times."""
    chunks = []
    pending = []
    for word in words:
        candidate = " ".join(item["text"] for item in [*pending, word])
        if pending and (len(candidate) > 74 or word["end"] - pending[0]["start"] > 5.5):
            chunks.append(pending)
            pending = []
        pending.append(word)
        if word["text"].endswith((".", "?", "!", ";")) and len(pending) >= 4:
            chunks.append(pending)
            pending = []
    if pending:
        chunks.append(pending)
    for index in range(1, len(chunks)):
        previous, current = chunks[index - 1], chunks[index]
        if not previous[-1]["text"].endswith((".", "?", "!", ";")):
            while len(current) < 4 and len(previous) > 4:
                current.insert(0, previous.pop())
    result = []
    for index, chunk in enumerate(chunks):
        start = chunk[0]["start"]
        next_start = chunks[index + 1][0]["start"] if index + 1 < len(chunks) else float("inf")
        end = min(chunk[-1]["end"] + 0.16, next_start)
        result.append(f"{index + 1}\n{timestamp(start)} --> {timestamp(end)}\n"
                      + " ".join(item["text"] for item in chunk))
    return "\n\n".join(result) + "\n"


def restore_punctuation(words, speech):
    # WordBoundary text omits punctuation. Recover it from the authored text
    # while retaining the service's timing for every spoken word.
    source = speech.replace("’", "'").replace("‘", "'")
    cursor = 0
    for word in words:
        token = word["text"].replace("’", "'").replace("‘", "'")
        start = source.casefold().find(token.casefold(), cursor)
        if start < 0:
            continue
        cursor = start + len(token)
        end = cursor
        while end < len(source) and source[end] in ".,!?;:…\"”":
            end += 1
        word["text"] += source[cursor:end]
        cursor = end


def duration(file):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(file)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


async def narrate(scene, args, output, semaphore):
    scene_id = scene["id"]
    if not isinstance(scene_id, str) or not scene_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in scene_id):
        raise ValueError(f"Scene ID must be a safe filename: {scene_id!r}")
    speech = scene["narration"]
    fingerprint = hashlib.sha256(json.dumps(
        [speech, args.voice, args.rate, edge_tts.__version__, "captions-v2"], ensure_ascii=False
    ).encode()).hexdigest()
    media = output / f"{scene_id}.mp3"
    words_file = output / f"{scene_id}.words.json"
    subtitles = output / f"{scene_id}.srt"
    stamp = output / f"{scene_id}.sha256"
    cached = all(path.exists() for path in (media, words_file, subtitles, stamp)) and stamp.read_text() == fingerprint
    if not cached:
        async with semaphore:
            for attempt in range(3):
                try:
                    words = []
                    stream = edge_tts.Communicate(speech, voice=args.voice, rate=args.rate, boundary="WordBoundary")
                    with media.open("wb") as audio:
                        async for chunk in stream.stream():
                            if chunk["type"] == "audio":
                                audio.write(chunk["data"])
                            elif chunk["type"] == "WordBoundary":
                                words.append({
                                    "text": html.unescape(chunk["text"]),
                                    "start": round(chunk["offset"] / 10000000, 6),
                                    "end": round((chunk["offset"] + chunk["duration"]) / 10000000, 6),
                                })
                    if not words or media.stat().st_size < 1000:
                        raise RuntimeError(f"Incomplete speech response for {scene_id}")
                    restore_punctuation(words, speech)
                    words_file.write_text(json.dumps(words, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                    subtitles.write_text(captions(words), encoding="utf-8")
                    stamp.write_text(fingerprint)
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(2 ** (attempt + 1))
    # Caption layout can be refined without another speech-service request.
    words = json.loads(words_file.read_text(encoding="utf-8"))
    subtitles.write_text(captions(words), encoding="utf-8")
    seconds = duration(media)
    print(f"{'cached' if cached else 'generated'} {scene_id}: {seconds:.3f}s", flush=True)
    return {
        "id": scene_id,
        "file": media.relative_to(ROOT).as_posix(),
        "duration": seconds,
        "subtitles": subtitles.relative_to(ROOT).as_posix(),
        "words": words_file.relative_to(ROOT).as_posix(),
        "narrationSha256": hashlib.sha256(speech.encode()).hexdigest(),
    }


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenes", default="assets/video-scripts/settings-walkthrough-scenes.json")
    parser.add_argument("--output", default=".build/settings-walkthrough/audio")
    parser.add_argument("--voice", default="en-US-AriaNeural")
    parser.add_argument("--rate", default="-8%")
    args = parser.parse_args()
    scenes = json.loads((ROOT / args.scenes).read_text(encoding="utf-8-sig"))
    if isinstance(scenes, dict):
        scenes = scenes["scenes"]
    if len({scene["id"] for scene in scenes}) != len(scenes):
        raise ValueError("Scene IDs must be unique")
    output = (ROOT / args.output).resolve()
    if not output.is_relative_to(ROOT):
        raise ValueError("Output must be inside this repository")
    output.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(2)
    results = await asyncio.gather(*(narrate(scene, args, output, semaphore) for scene in scenes))
    manifest = {
        "engine": "edge-tts",
        "engineVersion": edge_tts.__version__,
        "voice": args.voice,
        "rate": args.rate,
        "duration": round(sum(scene["duration"] for scene in results), 6),
        "scenes": results,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Voiceover complete: {len(results)} scenes, {manifest['duration']:.3f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
