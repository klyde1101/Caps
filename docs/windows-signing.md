# Windows publisher identity

The declared author is **Klyde Alexander V. Penus**, configured in `build/publisher.json`. Setup uses it in its interface, Company name file property, and the Windows installed-app Publisher entry.

Windows' security prompt verifies a digital signature. File properties and a self-signed certificate do not establish public publisher trust. This beta has no trusted code-signing certificate and remains unsigned.

To replace “Unknown publisher,” obtain a code-signing certificate issued to the intended publisher by a publicly trusted provider, or complete identity verification for Microsoft Artifact Signing where eligible. The publisher shown by Windows comes from the verified signing identity.

After the final build, sign and timestamp the Setup EXE using the certificate provider's instructions and SHA-256. Verify the signature with SignTool's Authenticode policy (`signtool verify /pa /v`), test the signed installer's extraction, then regenerate `SHA256SUMS.txt` before uploading. Signing changes the file's checksum. The installer payload footer can be located before an Authenticode certificate table; signing must happen after packaging.

The signing certificate may resolve publisher identity while SmartScreen can still show reputation warnings for a new release. Do not promise that signing removes all Windows warnings.

References: [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).
