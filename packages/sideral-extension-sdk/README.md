# Sideral Extension SDK

This package contains compile-time contracts only. Install it as a development
dependency and use `import type`; it contributes zero runtime bytes to an
extension bundle.

An extension ships one bundled ESM worker entry and its manifest. The editor
supplies every runtime capability through `ExtensionApi`.
