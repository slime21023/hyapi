import {readFileSync} from 'node:fs';
import {defineConfig} from 'vitepress';

const {version} = JSON.parse(
  readFileSync(
    new URL('../../packages/core/package.json', import.meta.url),
    'utf8',
  ),
);

export default defineConfig({
  title: 'HyAPI',
  lang: 'en-US',
  description: 'Typed HTTP composition for modular applications.',
  base: '/hyapi/',
  cleanUrls: false,
  ignoreDeadLinks: false,
  cacheDir: '.vitepress/cache',
  outDir: '.vitepress/dist',
  themeConfig: {
    search: {provider: 'local'},
    outline: [2, 3],
    socialLinks: [
      {icon: 'github', link: 'https://github.com/slime21023/hyapi'},
    ],
    nav: [
      {text: 'Guide', link: '/guide/quickstart'},
      {text: 'Reference', link: '/reference/core'},
      {text: 'ERP example', link: '/examples/erp'},
      {text: `v${version} (unreleased)`, link: '/'},
    ],
    sidebar: [
      {text: 'Overview', link: '/'},
      {
        text: 'Getting started',
        items: [{text: 'Quickstart', link: '/guide/quickstart'}],
      },
      {
        text: 'Guides',
        items: [
          {text: 'Modules and routes', link: '/guide/modules'},
          {text: 'HTTP inputs, responses, and errors', link: '/guide/http'},
          {text: 'Authentication and authorization', link: '/guide/auth'},
          {
            text: 'Dependency injection and lifecycle',
            link: '/guide/di-lifecycle',
          },
          {text: 'OpenAPI', link: '/guide/openapi'},
          {text: 'Testing applications', link: '/guide/testing'},
        ],
      },
      {text: 'Examples', items: [{text: 'Modular ERP', link: '/examples/erp'}]},
      {
        text: 'Reference',
        items: [{text: 'Core API reference', link: '/reference/core'}],
      },
    ],
  },
});
