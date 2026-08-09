# Creating a translation

No build tools are required to add a display language.

1. Open **Settings → Community translations → Open translations folder**.
2. Copy `locale.example.json` to a simple name such as `es.json` or `de-DE.json`.
3. Change `locale`, `name`, `direction` and every value under `messages`.
4. Keep `schemaVersion` at `1` and do not add or remove message keys.
5. Save the file and return to Sideral Editor. The locale appears automatically when
   the app regains focus.

Abbreviated header (a valid translation must continue with every English message key):

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

Use `rtl` only for right-to-left languages. The included JSON Schema provides
editor feedback. Runtime validation is stricter: it rejects missing keys,
unknown keys, blank messages, duplicate locale identifiers, invalid JSON and
files larger than 512 KiB. Exact diagnostics are shown in Settings.

English (`locales/en.json`) is the authoritative key list. Copying that file is
the safest way to start a complete translation.
