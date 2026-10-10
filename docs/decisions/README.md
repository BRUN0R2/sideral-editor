# Architecture decisions

These records explain the accepted extension design. Practical workflows belong
in [authoring](../EXTENSIONS.md); current types and limits belong in
[the API reference](../EXTENSION-API.md).

| Decision | Reason |
| --- | --- |
| [0001: Native extension system](0001-native-extension-system.md) | One signed format and explicit native capabilities |
| [0002: Deterministic runtime](0002-deterministic-extension-runtime.md) | Acknowledgements, generations and owned cancellation |
| [0003: Discord presence](0003-discord-presence-capability.md) | Metadata-only integration through a native owned session |
| [0004: Extension-owned previews](0004-extension-owned-previews.md) | Shared development tools with independent bundles and presentation |

All records are accepted. Protocol changes are recorded historically: Discord
introduced protocol 3; extension-owned visual trees replaced it with protocol 4.
The current runtime supports protocol 4 without a compatibility decoder.
