import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    lang: 'zh-CN',
    title: 'Metapi 文档',
    description: 'Metapi 使用文档、FAQ 与维护协作指南',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,
    themeConfig: {
      siteTitle: 'Metapi Docs',
      logo: '/logos/logo-icon-512.png',
      nav: [
        { text: '首页', link: '/' },
        { text: '快速上手', link: '/getting-started' },
        { text: '上游接入', link: '/upstream-integration' },
        { text: 'FAQ', link: '/faq' },
        { text: '文档维护', link: '/README' },
        { text: '项目主页', link: 'https://github.com/cita-777/metapi' },
      ],
      sidebar: [
        {
          text: '开始',
          items: [
            { text: '文档首页', link: '/' },
            { text: '快速上手', link: '/getting-started' },
            { text: '部署指南', link: '/deployment' },
          ],
        },
        {
          text: '使用与运维',
          items: [
            { text: '上游接入', link: '/upstream-integration' },
            { text: '配置说明', link: '/configuration' },
            { text: '客户端接入', link: '/client-integration' },
            { text: '运维手册', link: '/operations' },
            { text: '常见问题 FAQ', link: '/faq' },
          ],
        },
        {
          text: '文档维护',
          items: [
            { text: '文档维护与贡献', link: '/README' },
            { text: '目录规范', link: '/project-structure' },
            { text: 'FAQ/教程贡献规范', link: '/community/faq-tutorial-guidelines' },
          ],
        },
      ],
      socialLinks: [
        { icon: 'github', link: 'https://github.com/cita-777/metapi' },
      ],
      outline: {
        level: [2, 3],
      },
      footer: {
        message: 'MIT Licensed',
        copyright: 'Copyright (c) 2026 Metapi Contributors',
      },
      search: {
        provider: 'local',
      },
    },
  }),
);
