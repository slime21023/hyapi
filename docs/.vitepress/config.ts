import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "HyAPI",
  description: "A structured, type-safe API framework for Deno.",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "GitHub", link: "https://github.com/slime21023/hyapi" },
    ],
    sidebar: {
      "/guide/": [{
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Routes and Responses", link: "/guide/routes" },
          { text: "Composition", link: "/guide/composition" },
          { text: "Configuration", link: "/guide/configuration" },
          { text: "HTTP and OpenAPI", link: "/guide/http-and-openapi" },
          { text: "Optional Packages", link: "/guide/plugins" },
          { text: "Operations", link: "/guide/operations" },
        ],
      }],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/slime21023/hyapi" }],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 HyAPI contributors",
    },
  },
});
