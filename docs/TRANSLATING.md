# Add a display language

Community translations are JSON files; no build tools are required.

1. Open **Settings → Community translations → Open translations folder**.
2. Copy `locale.example.json` to a simple filename such as `es.json`.
3. Change `locale`, `name`, `direction` and every value under `messages`.
4. Keep `schemaVersion: 1` and all English message keys.
5. Save, then return focus to Sideral. The language appears in Settings.

Abbreviated header; a complete file must include **every** English message key:

```json
{
  "$schema": "./locale.schema.json",
  "schemaVersion": 1,
  "locale": "es",
  "name": "Español",
  "direction": "ltr",
  "messages": {
    "app.name": "Sideral Editor"
  }
}
```

Use `rtl` for right-to-left languages. Preserve interpolation placeholders in
message values. The generated schema provides editor feedback; native validation
rejects invalid JSON, missing/unknown keys, blank messages, duplicate locale IDs
and files larger than 512 KiB. Settings shows the diagnostic.

[English](../locales/en.json) defines the authoritative message keys.
[Built-in Brazilian Portuguese](../locales/pt-BR.json) is another complete example.
System-language selection uses available locales; manual selection is persisted.
