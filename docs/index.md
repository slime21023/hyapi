---
layout: home
hero:
  name: HyAPI
  text: Contract-first HTTP APIs for Deno
  tagline: >-
    Write the contract in TypeScript. Handlers get native types; consumers in any language get a
    faithful, governed OpenAPI 3.1 document.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Example application
      link: https://github.com/slime21023/hyapi/tree/main/apps/example
features:
  - title: The contract comes first
    details: >-
      Operations, schemas, responses, and security are declared in TypeScript with TypeBox and
      reviewed before any handler exists.
  - title: Native types, no generation
    details: >-
      Handler input, results, and security identities are inferred from the contract. Change the
      contract and the editor points at the handlers to update.
  - title: OpenAPI as the deliverable
    details: >-
      `hyapi emit` compiles the contract into a deterministic OpenAPI 3.1 document. Runtime and
      document come from one interpretation of the contract, so they cannot disagree.
  - title: Governed evolution
    details: >-
      `hyapi diff` classifies every change against main and fails on breaking changes unless they
      are explicitly allowed.
  - title: Enforced at runtime
    details: >-
      Requests are validated, security is evaluated, undeclared response fields are stripped, and
      every error is an RFC 9457 problem.
  - title: Web-standard and small
    details: >-
      An application is a `fetch(request)` handler with lifecycle, health, and events. No
      middleware, no service container.
---
