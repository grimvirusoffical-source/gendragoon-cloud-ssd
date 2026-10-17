# gendragoon-cloud-ssd

GenDragoon Cloud SSD release assets, storage SDKs and macOS integration
components. No user data or Google credentials belong in this repository.

- [macOS components and current integration status](macos/README.md)
- [Reference-package installer](macos/INSTALL.md)
- [Google Cloud destination and application upload UI](macos/UPLOAD_INTEGRATION.md)
- [Drive cleanup](macos/CLEANUP_INTEGRATION.md)
- [Plan selection and checkout adapter](macos/PLAN_INTEGRATION.md)
- [Storage SDKs](sdk/README.md)

The main native app project and backend are not included. The macOS components
require native integration, a signed build and live staging validation before
they can update the installed app. See the linked documentation for exact
prerequisites and tests.
