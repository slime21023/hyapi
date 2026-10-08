# Security Policy

## Supported versions

HyAPI is being redesigned and has no published release. The superseded `1.0.0-rc.x` candidates are
not supported. This table will list supported versions once the first version is published.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Private Vulnerability Reporting: open the
**Security** tab of [slime21023/hyapi](https://github.com/slime21023/hyapi) and choose **Report a
vulnerability**. Do not open a public issue for a suspected vulnerability.

The maintainer replies within 7 days, confirms whether the report is accepted, and coordinates a fix
and disclosure date with the reporter.

## Security baseline

The security defaults of the new design are specified in
[ADR 0001](_adr/0001-contract-first-api-library.md) and in the component specifications under
[`_adr/components/`](_adr/components/README.md): security requirements declared in contracts and
enforced by Core, mandatory request validation, stripping of undeclared response fields, request
size limits and timeouts, and hidden internal error details outside development mode. This section
will document the concrete defaults once they are implemented.
