# Security Policy

## Release status

The 0.5.0 source is unreleased; local builds and tarballs do not establish npm publication. Historical release candidates and older APIs do not describe the current source.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Private Vulnerability Reporting: open the
**Security** tab of [slime21023/hyapi](https://github.com/slime21023/hyapi) and choose **Report a
vulnerability**. Do not open a public issue for a suspected vulnerability.

The maintainer coordinates triage, a fix, and disclosure with the reporter.

## Security boundary

Applications choose module `authenticate` behavior and their own authorization policy. Core maps internal errors to safe Problem JSON responses. Network access, request body limits, and timeout policies are external to Core and must be configured by the application or its infrastructure. The private [ERP example](apps/example/src/app.ts) implements its own Bearer authentication; its choices are not Core defaults.
