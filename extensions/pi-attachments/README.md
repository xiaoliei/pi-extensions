# pi-attachments

Paste / drag & drop attachment tray for the [pi coding agent](https://github.com/xiaoliei/pi-mono).

- **Ctrl+V**: clipboard screenshot becomes an image attachment (no path injected into your prompt)
- **Ctrl+V with copied files**: Explorer/Finder copied files (or a copied file path) become attachments
- **Drag & drop** image files into the terminal: goes into the tray
- **Thumbnails**: queued images render above the editor (kitty/iTerm graphics protocols, text fallback otherwise)
- **`/attachments`**: list queued attachments and remove any of them
- **On submit**:
  - vision models receive images as base64 `ImageContent` (up to 4MB each)
  - non-vision models receive file paths appended to the prompt instead (the agent can `read` them)
  - non-image files always append their path to the prompt

## Install

Copy or symlink the package into an extensions location, or register it as a pi package:

```
~/.pi/agent/extensions/pi-attachments -> <this directory>
```

or in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["<path to this directory>"]
}
```

No runtime dependencies. Works on Windows, WSL, macOS, and Linux (wl-paste/xclip).

## Notes

- Clipboard image support: PNG/JPEG/GIF/WebP. BMP and exotic formats fall back to file-path attachment.
- The paste keybinding is matched against pi's default (`ctrl+v`, `alt+v` on Windows). On Windows both Ctrl+V and Alt+V trigger the tray. Note: Windows Terminal intercepts Ctrl+V for text-only pasting — image-only clipboards need Alt+V there (or remove WT's Ctrl+V binding). Custom rebinds of `app.clipboard.pasteImage` are not observed.
- In RPC mode the tray still works for submission; the thumbnail widget is TUI-only.
