# gendragoon-cloud-ssd

GenDragoon Cloud SSD native clients, backend, release tooling, and storage SDKs.
No user data, private API keys, or Google credentials belong in this repository.

- [Integrated native application and backend](native/README.md)
- [Current validation and release gates](native/VALIDATION.md)

- [macOS components and current integration status](macos/README.md)
- [Reference-package installer](macos/INSTALL.md)
- [Google Cloud destination and application upload UI](macos/UPLOAD_INTEGRATION.md)
- [Drive cleanup](macos/CLEANUP_INTEGRATION.md)
- [Plan selection and checkout adapter](macos/PLAN_INTEGRATION.md)
- [Storage SDKs](sdk/README.md)

The `native` tree contains the full app imported from the existing macOS source
and integrated with the components in `macos`. The latter directory is retained
as the original component/reference implementation. Use `native` for current
application builds. A successful source test or signature check alone does not
make a release eligible for automatic installation; see the release gates.
