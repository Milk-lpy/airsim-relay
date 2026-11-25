# Apple APNs provider certificate trust

The local provider-certificate validator uses Apple's public Apple Root CA and
Worldwide Developer Relations G4 intermediate. Apple lists both at
[Apple PKI](https://www.apple.com/certificateauthority/). The G4 certificate
chains to this root. These files are separate from the HTTPS gateway's trust
store and the relay operator's provider credentials.

| Official DER | SHA-256 of DER |
| --- | --- |
| [Apple Root CA](https://www.apple.com/appleca/AppleIncRootCertificate.cer) | b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024 |
| [WWDR G4](https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer) | ea4757885538dd8cb59ff4556f676087d83c85e70902c122e42c0808b5bce14c |

During packaging, the same public DER files were retrieved from the
[fastlane certificate bundle](https://github.com/fastlane/fastlane/tree/master/fastlane/lib/assets/certificates)
and [apple-platform-rs certificate bundle](https://github.com/indygreg/apple-platform-rs/tree/main/apple-codesign/src/apple-certs),
then converted to PEM. The image build verifies both fingerprints and the G4 signature.
