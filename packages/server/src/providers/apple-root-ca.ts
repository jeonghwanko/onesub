/**
 * Apple Root CA certificates used to verify StoreKit 2 signed transactions.
 *
 * Apple signs JWS transactions with an ECDSA key; the signing certificate
 * chain is embedded in the JWS `x5c` header. To trust the leaf key we must
 * validate the chain all the way up to one of Apple's published root CAs.
 *
 * Source: https://www.apple.com/certificateauthority/
 * These certificates are public and static. Update this list if Apple
 * publishes a new root — existing JWS signed with older roots continue to
 * validate against their original root.
 */

/**
 * Apple Root CA - G3 (current root for StoreKit 2 / App Store Server API).
 * SHA-256 fingerprint: 63343ABF B89A6A03 EB994052 C5ADBBF8 A87E2C46 81F6F0FC C8A4DA48 95F0FBBF
 * Valid: 2014-04-30 — 2039-04-30
 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/**
 * All Apple root CAs accepted for StoreKit 2 JWS validation.
 * Currently only G3; add G4 here when Apple publishes it.
 */
export const APPLE_ROOT_CA_PEMS = [APPLE_ROOT_CA_G3_PEM];
