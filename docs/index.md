---
layout: home
hero:
  name: HyAPI
  text: Structured APIs for Deno
  tagline: Compose type-safe HTTP APIs from modules, Ports, and explicit lifecycle boundaries.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/slime21023/hyapi
features:
  - title: Typed contracts
    details: Define routes with TypeBox schemas and use the same metadata for runtime validation and OpenAPI.
  - title: Explicit composition
    details: Keep modules independent through named Ports, scoped services, and small plugin capabilities.
  - title: Native boundaries
    details: Use Web-standard Request, Response, fetch, AbortSignal, and Deno without hiding transport details.
---

# HyAPI documentation

HyAPI is a structured, type-safe API framework for Deno. Start with the
[guide](/guide/getting-started), then use the example application as a complete reference for health
checks, guard-based authentication, modules, and Ports.

This site documents how to use HyAPI. Architecture decisions, release history, benchmarks, and
migration records live in the repository's
[`_design/`](https://github.com/slime21023/hyapi/tree/main/_design) directory.
