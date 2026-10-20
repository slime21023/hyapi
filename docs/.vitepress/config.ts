import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "HyAPI",
  description: "Elysia-native HTTP application composition for Node 24 and Bun.",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "GitHub", link: "https://github.com/slime21023/hyapi" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Migration to 0.5.0", link: "/guide/migration-to-0.5" },
            { text: "Routes and Guards", link: "/guide/routes" },
            { text: "Composition", link: "/guide/composition" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "HTTP and OpenAPI", link: "/guide/http-and-openapi" },
            { text: "Elysia Extensions", link: "/guide/plugins" },
            { text: "Operations", link: "/guide/operations" },
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
