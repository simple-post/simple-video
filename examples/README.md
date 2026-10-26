# Example recipes

- `slideshow.json`: three linked generated images with subtle parallax.
- `comparison.json`: a fictional robot matchup with independent split-screen panels and a final-round reversal.
- `single.json`: one generated scenic photo animated in a steady direction.
- `local-photos.json`: the slideshow using your own `photos/start.jpg`, `photos/middle.jpg` and `photos/finish.jpg`; replace those paths with real files relative to the recipe.

Inspect without spending:

```sh
node bin/run.js plan --recipe examples/slideshow.json
```

For a complete local demo with included original sample artwork, run `init ./demo --local` rather than the local-photo example's user-supplied image paths. For generated examples, supply your own key and use an explicit run ID and `--execute`. Edit budgets and prompts before generation; no music is included.
