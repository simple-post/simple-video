# Renderer setup

DepthFlow is a local Python/OpenGL renderer controlled by the TypeScript CLI. Depth estimation runs locally through Transformers.js/ONNX. Python is required for the default renderer; the optional CPU renderer uses Node.js and has different visual characteristics.

```sh
simple-video setup --dry-run
simple-video setup
simple-video doctor --check-render
```

Setup downloads a platform-specific uv 0.13.5 archive from Astral's official GitHub release and verifies its pinned SHA-256 digest before extraction. uv creates a managed Python 3.12 virtual environment. Setup installs pinned DepthFlow 0.9.1, ShaderFlow 0.9.1, Broken 0.9.1, PyTorch 2.7.1 and torchvision 0.22.1. Transitive Python dependencies are resolved by uv; they are not yet frozen in a cross-platform lockfile. Unused PyAudio microphone support is excluded. Model weights are prepared unless `--skip-model` is selected.

System Python and shell profiles are not changed. No sudo command is executed. Simple Video has no npm postinstall downloader; its runtime downloads are explicit in setup. Node dependencies can have their own install hooks. Set `ONNXRUNTIME_NODE_INSTALL=skip` during npm installation to skip optional CUDA downloads for the Node depth estimator. A receipt is saved at `HOME/setup.json`. Re-running setup repairs/reconciles packages in that same environment. Do not relocate an installed virtual environment; recreate it using a new `--home` instead.

## Locations and overrides

| Setting                  | Default                                            |
| ------------------------ | -------------------------------------------------- |
| macOS home               | `~/Library/Caches/simple-video`                    |
| Linux home               | `${XDG_CACHE_HOME:-~/.cache}/simple-video`         |
| Windows home             | `%LOCALAPPDATA%/simple-video`                      |
| Python/renderer          | `HOME/depthflow`                                   |
| Managed Python downloads | `HOME/python`                                      |
| Depth model              | `HOME/models`                                      |
| Other runtime caches     | `HOME/workspace`, `HOME/huggingface`, `HOME/torch` |

Use `--home PATH` or `SIMPLE_VIDEO_HOME` for a different home. `--uv /path/to/uv` uses an existing uv binary. `--python 3.12` selects the managed Python version on initial installation. `SIMPLE_VIDEO_DEPTHFLOW` selects an externally managed renderer; its compatibility is your responsibility. Render outputs are always stored in the project's data root, separate from the runtime home.

## System prerequisites

- Node.js 24+.
- FFmpeg with libx264 and ffprobe on PATH.
- A functioning OpenGL 3.3+ driver/context for DepthFlow. npm and uv cannot install GPU drivers.
- `tar` for uv archive extraction (including the Windows archive).
- Internet access for setup and the first depth-model download. Generation additionally needs your own provider key.

`doctor` checks dependency presence without loading weights. `doctor --depth` downloads/loads the pinned depth model. `doctor --check-render` renders a tiny H264 clip with synthetic depth; it checks the graphics path without downloading a model or making a paid API call. Before paid full-video generation, create performs this graphics probe. `--images-only` skips rendering preflight.

## Support status

The bootstrap includes macOS arm64/x64, glibc Linux arm64/x64 and Windows x64 artifacts. **The real managed install and GPU render have been verified on Apple Silicon macOS.** Bootstrap availability does not prove that all graphics stacks work. Windows, Intel macOS, Linux GPU drivers and headless software GL still need dedicated rendering validation. Alpine/musl and Windows ARM bootstrap are not supported.

For servers, use a tested EGL/OpenGL stack and run the render probe first. If graphics initialization fails, inspect the driver/context rather than silently changing renderers. Choose `video.parallaxEngine: "cpu"` explicitly for the Node-based alternative. There is no automatic quality-changing fallback.

## Troubleshooting

- **DepthFlow missing:** run setup using the same `--home` used for rendering.
- **Graphics/GLFW/EGL failure:** run doctor with `--check-render` outside a restricted graphics sandbox. Check the machine's OpenGL support. The CLI cannot grant GPU permissions.
- **FFmpeg missing:** install it using the operating system's package manager; doctor lists missing binaries.
- **Model cannot download:** check proxy/network access; run `doctor --depth` once while connected.
- **No key:** provide `OPENAI_API_KEY` through your environment or an explicitly selected env file. Local-photo mode needs no key.
- **Install interruption:** rerun setup; it reuses the managed environment and caches.
- **Checksum mismatch:** installation stops before executing the downloaded binary. Investigate the download rather than disabling verification.

Upstream: [uv Python management](https://docs.astral.sh/uv/guides/install-python/), [DepthFlow 0.9.1](https://pypi.org/project/depthflow/0.9.1/).
