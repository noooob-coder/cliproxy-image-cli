---
name: cliproxy-image-cli
description: Use when the user asks Codex to generate or edit an image in this local environment, including generic prompts such as “画一张风景图” or “构建一副海报”, even if they do not mention the CLI or an output path. This skill wraps the installable `cliproxy-image-cli` command for one-off image generation, masked edits, and saving image files plus optional metadata to disk. Prefer it when the result should exist as a local file; if no path is given, save into the current Codex working directory.
---

# Codex-native Image CLI

Use this skill to drive the installable `cliproxy-image-cli` command for image generation and image editing.

## When to use

- The user makes a generic image-creation request in Codex, and a local file result is acceptable even if they did not explicitly ask for a path yet.
- The user wants a local image file generated from a prompt.
- The user wants to edit one or more local images with an optional mask.
- The user wants the generated image saved to a specific filesystem path.
- The user is already working in Codex and wants the CLI to reuse that local Codex configuration automatically.

Do not use this skill for:

- web image search
- SVG/vector editing
- tasks that only need text guidance without producing files

## Default assumptions

- Required CLI entrypoint: `cliproxy-image-cli`
- Default model: `gpt-image-2`
- Codex config source: `~/.codex/config.toml`
- Codex auth source: `~/.codex/auth.json`

Do not ask the user for a base URL or port during normal use. The CLI should autodiscover Codex configuration first.

## Core commands

### Generate a new image

```powershell
cliproxy-image-cli generate `
  --output E:\project\cpa\image_skill\outputs\astronaut-cat.png `
  "一只戴宇航员头盔的橘猫，电影感，超清"
```

Useful optional flags:

- `--size 1024x1024|1536x1024|1024x1536|auto` (default: `1024x1024`)
- `--quality high`
- `--background transparent`
- `--output-format png|jpeg|webp`
- `--metadata-path <json-file>`
- `--overwrite`
- `--prompt-file <txt-file>`

### Edit existing images

```powershell
cliproxy-image-cli edit `
  --image E:\project\cpa\image_skill\input.png `
  --mask E:\project\cpa\image_skill\mask.png `
  --output E:\project\cpa\image_skill\outputs\edited.png `
  "把背景改成雪山，保留主体"
```

Repeat `--image` to send multiple source images.

## Operating rules

1. If the user gives a target output path, use it exactly.
2. If the user does not give an output path, default to the current Codex working directory and mention the chosen path.
3. Do not overwrite existing files unless the user asked for replacement or the command includes `--overwrite`; prefer a new default filename when auto-choosing a path.
4. If the user simply asks to “画/生成/构建”一张图片而没有指定 skill、CLI 或路径, treat that as a valid trigger for this skill in the local Codex environment and continue without bouncing to a more generic image workflow first.
5. Size handling should mirror `imagegen`: allowed values are `1024x1024`, `1536x1024`, `1024x1536`, and `auto`.
6. Size selection order should be: explicit user size > Codex heuristic > default `1024x1024`.
7. Use this Codex-side heuristic when the user did not specify a size:
   - choose `1536x1024` for obviously wide outputs such as 横图、横版、横幅、banner、hero、封面横版、壁纸、全景、宽屏场景、landscape wallpaper
   - choose `1024x1536` for obviously tall outputs such as 竖图、竖版、海报、封面竖版、手机壁纸、poster、book cover
   - choose `1024x1024` for generic requests, avatars, icons, square compositions, or when orientation is unclear
   - choose `auto` only when the user explicitly asks for auto/original ratio/adaptive sizing
8. Before invoking the CLI, Codex should decide whether the user's prompt is already specific enough for `gpt-image-2`; if not, Codex should rewrite or expand it first and then pass the final prompt to the CLI.
9. If a prompt is long or multiline, write it to a UTF-8 text file and use `--prompt-file`.
10. If the user wants response details, add `--metadata-path` and preserve the JSON file only if the user needs it afterward.
11. For edits, local paths are preferred over remote URLs when the source images are already on disk.

## Installation shortcuts

### npm

```powershell
npm install -g cliproxy-image-cli
```

### Homebrew

After publishing the npm package and formula to your tap:

```bash
brew install <your-tap>/cliproxy-image-cli
```

## Minimal verification

After the command runs:

- confirm exit code is `0`
- confirm the output file exists
- if metadata was requested, confirm the metadata JSON exists and includes `saved_files`

## Failure handling

- HTTP errors are surfaced by the CLI as `Error: HTTP <code>: <message>`.
- Missing credentials: verify local Codex auth exists in `~/.codex/auth.json`.
- Missing command: install the CLI first instead of falling back to a local Node path.
- Existing file conflict: rerun with a new output path or `--overwrite` if the user approved replacement.
