# pi-extensions

Custom extensions for the [pi coding agent](https://github.com/earendil-works/pi), published to npm under the `@xiaoliyo` scope.

## Extensions

| Directory | npm package | Description |
|-----------|-------------|-------------|
| `extensions/ask-question` | `@xiaoliyo/pi-ask-question` | Lets the LLM ask the user to clarify requirements or make choices (single/multi-choice, free-text) |
| `extensions/pi-attachments` | `@xiaoliyo/pi-attachments` | Paste/drag image and file attachments with inline thumbnails |
| `extensions/plan-mode` | `@xiaoliyo/pi-plan-mode` | Read-only planning workflow (`/plan`) with a proposed-plan execution dialog |

## Installing

```bash
pi install npm:@xiaoliyo/pi-ask-question
pi install npm:@xiaoliyo/pi-attachments
pi install npm:@xiaoliyo/pi-plan-mode
```

## Releasing

Versions come from git tags - the repo copy of `version` is display-only. Tag format: `<extension>-v<semver>`.

```bash
git tag ask-question-v0.1.0
git push origin ask-question-v0.1.0
```

Pushing the tag triggers `.github/workflows/release.yml`, which runs tests, stamps the tag version into `package.json`, and publishes to npm. Requires the `NPM_TOKEN` repository secret.

## Adding a new extension

1. Create `extensions/<name>/` with a `package.json` (any non-empty `name`), source, and tests. Set `pi.extensions` to the entry point, e.g. `{"pi": {"extensions": ["./src/index.ts"]}}`.
2. Provide `test` and `check` scripts; CI runs `npm ci && npm test && npm run check` per extension.
3. Commit and push - CI discovers it automatically. Release it with `<name>-v<semver>` tags.

## Development

Each extension is standalone (no workspace). From its directory:

```bash
npm install --ignore-scripts
npm test        # vitest or node --test
npm run check   # tsc --noEmit
```

Imports use the `@mariozechner/pi-*` scope, which pi's extension loader aliases to its bundled host modules at runtime; devDependencies pin the upstream `@earendil-works/pi-*` packages for tests and type checking only.
