---
layout: home
hero:
  name: HyAPI
  text: Declarative HTTP APIs for Node and Bun
  tagline: Compose typed routes with InferDI dependencies and explicit authentication boundaries.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/slime21023/hyapi
features:
  - title: Typed route callbacks
    details: Define module routes and validate requests and responses with Standard Schema.
  - title: Explicit composition
    details: Supply your InferDI root; opt in to lazy request scopes only where needed.
  - title: Protected boundaries
    details: Authenticate a module before validation, then authorize resources after validation.
---

# HyAPI v0.5.0 documentation

Start with the [guide](/guide/getting-started), then consult the [PostgreSQL ERP example](https://github.com/slime21023/hyapi/tree/main/apps/example) for transactions, JWT authentication, explicit OpenAPI, and Bun/Node startup. `hyapi` is the only public package; the example is private. Local source builds are not evidence of npm publication. Historical `_design/` migrations are not current API documentation.
