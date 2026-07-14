# WebBrain User Memory Tutorial

Manual local suite for the v1 user-memory feature. It is intentionally static:
no build step, no backend routes, and no network calls from the page itself.

## Run

```bash
python3 -m http.server 8765 -d test/memory
```

Open:

```text
http://127.0.0.1:8765/
```

Load the WebBrain extension in the browser and use the side panel against that
tab.

## Coverage

1. `/memory --add <text>` saves an explicit user memory immediately.
2. A completed form flow can create memory when Memory, Auto-learn, and Learn
   from completed forms are enabled.
3. A normal chat turn can create memory after the background extractor runs.
4. A later form can be filled from saved memories.
5. Profile auto-fill remains separate from memory and fills signup-style fields
   from the opt-in Profile text block.

## Notes

- Use fake values only. Do not enter real passwords, tokens, API keys, payment
  data, or private account information.
- Form-derived memory should save durable preferences or profile/workflow hints,
  not raw form values or page instructions.
- Auto-learning is asynchronous. Wait 10 to 30 seconds after a successful turn,
  then run `/memory` or refresh Settings -> Memory.
- For a clean run, export then clear existing memories before starting.
