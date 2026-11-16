# Video scenes

```webbrain-skill
{
  "summary": "Write the scenes of a video made of several generated clips (generate_image with scenes) so the clips match and show the idea.",
  "modes": ["act"],
  "intents": ["generate_video", "explainer_video", "video_story", "how_to_video"]
}
```

Use this skill before calling `generate_image` with `scenes`. The video model makes each scene as a separate clip from its text alone, without seeing the other clips; WebBrain then joins the clips into one video.

Keep the user's full requested length in `estimated_duration`. A 60-second video can use four 15-second scenes when the model supports that clip length. The per-clip limit does not limit the whole video, and no separate joining tool is needed. When clip lengths are unavailable, use the provider's stated default or eight 8-second scenes for about 64 seconds. Continue generation and report the measured result; missing metadata alone is not a blocker. If the tool asks for shorter scenes, split them into distinct prompts while keeping the full target. WebBrain retains that target across retries. For multiple video deliverables, give each a distinct `video_id` and reuse it when retrying; each video keeps its own target and measured result. Local ComfyUI workflows set their own length: omit unsupported video options on corrected retries while WebBrain retains the target for verification. A short, unverified, or unjoined result is incomplete: preserve and report the generated assets, and use a partial or failed outcome if the full video cannot be delivered or verified. Do not regenerate paid clips just to replace missing verification. When one clip fails, WebBrain keeps the finished clips for 30 minutes: retry with the same `prompt`, `aspect_ratio`, `resolution` and scenes, changing only the scene that failed, and only that scene is generated again.

## The shared prompt

`prompt` is repeated in front of every scene, so it is the only thing the clips share. Anything it leaves open will change from clip to clip. Write it as a short cast and set sheet:

- each recurring character: a name, age, hair, and clothes with their colours;
- the setting and its fixed layout: what is where, and its colours;
- the style, lighting and camera;
- the sound: natural sound, or a narrator with a described voice. No music unless the user asks for it, since every clip would get different music.

## Each scene

- One action a camera could film in the clip's few seconds. Call the characters by name; do not describe them again.
- Each scene is one clip, so keep it within the model's longest clip. WebBrain refuses a longer scene and names the limit; split it into scenes with their own prompts.
- Keep what changed earlier: a door opened in one scene is still open in the next.
- Show the idea happening. Video models cannot draw diagrams, arrows, equations, charts or readable text, so do not ask for them. To explain something, show it: repeat the experiment, put the outcomes side by side, or move in close on the mechanism.
- When the idea needs words, give the scene one short narrator line in quotes, about a dozen words for an 8-second clip.

## Explainers

- Take the explanation from the page or the user's request. Do not add facts, numbers or steps that are not there.
- Build the video around the one demonstration that makes the idea click: set it up, show it, and end on what it means.
- Three to five scenes are usually enough.
