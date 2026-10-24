# Security policy

## Reporting a vulnerability

Please report security issues privately to **support@whabuzz.com**. Do not open a public issue or pull request for a vulnerability.

Include what you found, how to reproduce it, and the version or commit you tested. Never include real customer data.

## Supported versions

Only the latest release.

## Security model

What the app protects, what it relies on you for, and how sessions, CSRF, rate limits, webhook signatures and secrets are handled is written up in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). Every route, its auth, CSRF and rate-limit rule is listed in [docs/ROUTES.md](docs/ROUTES.md).
