# Getting Started

## Requirements

- Deno 2.9 or later
- TypeBox 1.x schemas

## Candidate status

HyAPI `v1.0.0-rc.4` is a pre-release candidate. `@hyapi/core` and `@hyapi/cli` are not yet published
to JSR, so this guide does not provide an installation command.

## Evaluate the example

Run the checked-out example from the repository root:

```text
deno task dev
```

The example listens on `127.0.0.1:8000` by default. Set `HOST` and `PORT` when you need different
listener settings.

The example requires a JWT secret. Generate at least 32 random bytes and expose the value through
`JWT_SECRET`; do not use a human-chosen password as an HS256 key.

## Verify a checkout

When working on HyAPI itself, use one command to format, lint, type-check, test, inspect the
example, verify a generated starter, and build this documentation site:

```text
deno task verify
```

## Next steps

- Define [routes and responses](/guide/routes).
- Compose modules through [Ports and services](/guide/composition).
- Configure [OpenAPI documents](/guide/configuration).
- Add [optional HTTP plugins](/guide/plugins) around the native handler boundary.
