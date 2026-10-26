# Recipes, photos and audio

Run `simple-video schema` for the strict schema (`data` in the JSON response). Unknown properties fail validation. `init` supplies a complete editable recipe; `plan` expands it into exact images and scenes without network requests.

## Slideshow example

```json
{
  "version": 1,
  "type": "story",
  "name": "An afternoon outside",
  "look": "Natural afternoon photography with layered foreground and distant scenery.",
  "character": "A small terrier with a blue collar",
  "image": {
    "model": "gpt-image-2.5-flare",
    "quality": "medium",
    "files": { "shot-0": "photos/start.jpg", "shot-1": "photos/finish.jpg" }
  },
  "video": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "motion": "parallax",
    "parallaxEngine": "depthflow",
    "parallaxPath": "diagonal",
    "parallaxIntensity": 0.105,
    "audio": "silent"
  },
  "budget": {
    "maxRequests": 2,
    "maxEstimatedUsd": 2,
    "estimatePerImageUsd": 1
  },
  "shots": [
    {
      "prompt": "A small terrier facing a puddle in a layered garden scene.",
      "caption": "A small obstacle",
      "duration": 3
    },
    {
      "prompt": "The same terrier proudly standing across the garden puddle.",
      "caption": "A big achievement",
      "duration": 3,
      "referencePrevious": true
    }
  ]
}
```

With `image.files`, photos are imported and there are zero paid requests. Remove that property to generate photos from the prompts. Each file key must match the asset IDs returned by plan: slideshow/challenge uses `shot-0`, `shot-1`, etc.; single-photo uses `loop`; comparison uses `hero`, `opponents-0`, `reveal-0`, etc. Prompts remain required in local recipes so switching back to generation is explicit and reproducible. All photos in one create must use the same provider mode.

`referencePrevious: true` passes the previous image as an edit reference when generating a sequence. It cannot guarantee perfect continuity; review the images before publishing. `create --images-only` lets you stop before animation.

## Motion

DepthFlow's `parallaxIntensity` controls the amount of travel over the entire shot. Reduce it to slow and reduce movement while retaining duration. Start at `0.105`; use `0.07` for more delicate subjects. The comparison template uses `0.15`. `parallaxPath` is `pan` or `diagonal`; direction stays linear within each shot. `alternateDirections: true` changes direction at cuts only. Split-screen panels use opposite directions and independent depth maps.

`parallaxFit: "cover"` fills the frame; `"contain"` preserves wide source photos with a blurred background. Captions remain fixed above the moving image. Durations must be exact frame counts at the chosen fps. Current output is portrait 9:16, H264/AAC.

`parallaxEngine: "cpu"` enables the older Node renderer with `parallaxStrength` between 0.01 and 0.07. Closed `orbit` motion is supported there only; it deliberately reverses as part of the loop. The default DepthFlow path never uses orbit or a mid-shot reversal. Choose `motion: "zoom"` or `"static"` for an explicit alternative needing no Python.

## Comparison template

`init --template comparison` creates a fictional matchup. It has a fixed hero, increasing challenger counts, split-screen comparison images and full-frame outcome images. With `winnerPattern: "final-flip"`, the schema requires one side to win every round except the final one. Each round has `count` and `winner` (`hero` or `opponent`). `compareDuration` and `revealDuration` control segment length; the template uses 1.5 seconds each. These are fictional outcomes, not factual simulations.

Override `heroPrompt`, `opponentLook`, individual `opponentPrompt` or `revealPrompt` for precise compositions. A new run ID can reuse image requests that have not changed.

## Music and event effects

Start with silence or use your own licensed local recording:

```json
{
  "music": "recorded",
  "track": {
    "file": "music/comedy-track.mp3",
    "start": 5.75,
    "gainDb": 0,
    "credit": "Track title — artist, license and edit credit as required",
    "source": "https://example.com/original-track",
    "license": "https://creativecommons.org/licenses/by/4.0/"
  },
  "cues": [],
  "recordedCues": [
    {
      "file": "sounds/drill.wav",
      "at": 4.5,
      "start": 0,
      "duration": 0.6,
      "gainDb": -17
    }
  ]
}
```

Put that object under the recipe's `soundtrack`, or save it to `audio.json` and use `render --run NAME --soundtrack ./audio.json`. Paths resolve relative to the containing JSON file. The mixer selects the music excerpt, pads/trims to the video duration and adds only specified events. `audioLufs` optionally masters the complete mix to a target between -30 and -12 LUFS; this can require another audio encode but preserves video frames.

`start` is the source-music offset; `at` is an event's time in the finished video. Keep music dominant. Use no continuous effects unless the scene needs them. Attribution is preserved in exported metadata, but you must ensure the actual recording and its use on the target platform are permitted. No particular tune or recording is bundled.

The older synthesized `playful` and `suspense` scores are available for experimentation; silence and a chosen licensed recording are better defaults for publication.
