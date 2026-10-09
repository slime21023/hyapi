import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "HyAPI",
  description: "Contract-first HTTP APIs for Deno.",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Recipes", link: "/recipes/testing" },
      { text: "GitHub", link: "https://github.com/slime21023/hyapi" },
    ],
    sidebar: {
      "/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Contracts", link: "/guide/contracts" },
            { text: "Handlers", link: "/guide/handlers" },
            { text: "Runtime", link: "/guide/runtime" },
            { text: "Security", link: "/guide/security" },
            { text: "OpenAPI and the CLI", link: "/guide/openapi-and-cli" },
            { text: "Operations", link: "/guide/operations" },
            { text: "Plugins", link: "/guide/plugins" },
          ],
        },
        {
          text: "Recipes",
          items: [
            { text: "Testing", link: "/recipes/testing" },
            { text: "Typed clients", link: "/recipes/typed-client" },
            { text: "Mocking with Prism", link: "/recipes/mocking" },
            { text: "Observability", link: "/recipes/observability" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/slime21023/hyapi" }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 HyAPI contributors",
    },
  },
});
