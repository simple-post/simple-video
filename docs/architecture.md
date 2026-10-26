# Architecture

Simple Video is a local TypeScript CLI with a separately installed Python renderer. The original engine was developed for Paleoflux; this extraction contains reusable code, generic templates and original test fixtures rather than production media, credentials or dated batch scripts.

```text
recipe JSON
    → Zod validation and deterministic image/scene plan
    → local photos OR your OpenAI image API requests
    → verified content-addressed photo cache
    → local ONNX depth inference and edge protection
    → DepthFlow subprocess (or explicitly selected CPU renderer)
    → FFmpeg composition, fixed captions and audio mixing
    → full decode / timing / codec / hash validation
    → MP4, contact sheet, run receipts and local export
```

## Boundaries

- `cli.ts`: non-interactive commands, JSON results, progress and error handling.
- `project.ts`: recipe-relative paths, project initialization and validated export.
- `spec.ts`: public schema, generic templates and deterministic storyboard expansion.
- `runner.ts`: persistent request state, budget reservations, uncertain-outcome handling, shared cache and run locking.
- `provider.ts`: OpenAI generation/editing, local image import and synthetic fixtures. Only the OpenAI provider makes paid calls.
- `runtime.ts`: verified uv bootstrap, managed Python setup, runtime locations and real graphics probe.
- `depth.ts`: pinned local Depth Anything V2 Small ONNX inference.
- `depthflow.ts`: surface renderer invocation, silhouette expansion and independent panel camera paths.
- `parallax.ts`: explicitly selected Node/CPU alternative and image fit preparation.
- `render.ts`, `soundtrack.ts`, `rerender.ts`: media composition, audio, validation and cache-only variants.
- `skills/simple-video`: portable instructions for agents invoking the same CLI as users.

DepthFlow is executed through argument arrays without a shell. The CLI does not modify its source or bundle Python wheels in the npm artifact. npm dependencies are locked; top-level Python renderer versions and the depth-model revision are pinned. Python transitive resolution and GPU drivers can still differ between machines.

Generation responses and local receipts may contain prompts and provider usage. Treat the project cache as private. Generated assets, credentials and runtime files are not part of the package or Git repository. A future npm release requires deliberately removing both the private package flag and the publication guard; no release/publish workflow is configured.

## Scope of this preview

There is no prompt-to-idea agent, hosted renderer, general AI-video synthesis, scheduling service or social publishing inside this CLI. It produces controlled photo animations. Content selection and final review remain with the user. SimplePost handles publishing separately. Input files are local trusted project files, not a sandbox for hostile multi-tenant workloads.

The preview has macOS runtime/render verification and portable Node/FFmpeg regression tests. Cross-platform GPU validation, a frozen transitive Python lock and broader image-provider adapters remain future work.
