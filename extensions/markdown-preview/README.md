# Markdown Preview

Previews Markdown through an extension-owned parser and visual tree. It handles
GFM structures, links, inert HTML/image placeholders and code-block presentation.

## Use

Install its signed package, open a Markdown document, then run
**Markdown: Toggle Markdown Preview** or `Ctrl+Shift+V`. Unsaved source changes
update the bound preview through events, without polling.

Changing documents hides a bound panel while preserving its resource. Disabling
or reloading the extension releases panels and listeners. The generic host renders
validated elements; it never imports the Markdown parser.

## Develop and package

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extension:markdown:check
npm run extensions:package:dev
```

For a focused build use `npm run extension:markdown:build`. Validate or sign
`build/extensions/markdown-preview`, not this source directory. See
[authoring](../../docs/EXTENSIONS.md) for signing and installation, and
[preview contracts](../../docs/EXTENSION-API.md#output-and-previews) for API limits.
