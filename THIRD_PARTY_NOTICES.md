# Third-party notices

The Android 0.5.0 full-workbench variant additionally embeds the Tina workbench runtime
(the companion-only APK excludes it):
Node.js 24 for ARM64 Android, libc++ and Cortico 0.2.8 at commit
`ee6fb3e0b71d0c947942d855929f21eb08448ddd` (MIT), with a mobile Chat
provider and JavaScript module adaptation. Original license texts, source commit,
module hashes and adaptation details are included in the APK under
`assets/notices/`, `assets/runtime/UPSTREAM-MANIFEST.json` and the embedded
packages' license files. AndroidX Compose/Material and Kotlin notices are also
available in the offline handbook. No Coopanion desktop application, desktop
pet resources or third-party APK payload is copied into this distribution.

The locally generated pairing QR uses the `vendor/QRCode` component from
[`qrcode-terminal` 0.12.0](https://github.com/gtanner/qrcode-terminal),
distributed under Apache License 2.0. Its underlying QRCode for JavaScript
implementation is copyright Kazuhiko Arase and licensed under the MIT license.
Both license texts and source notices are included under
`src/vendor/qrcode-terminal/`. No pairing information is sent to a QR service.
