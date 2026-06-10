import { defineConfig } from 'vitepress'

const SITE_URL = 'https://docs.boxhaven.dev'
const SITE_NAME = 'BoxHaven'
const SITE_DESCRIPTION = 'Remote dev boxes for AI coding agents. Create a box, resume your agent session on it, disconnect, let it work.'
const SOCIAL_IMAGE_URL = `${SITE_URL}/logo.png`
const SOCIAL_IMAGE_ALT = 'The BoxHaven logo: a cozy wooden house sheltering three friendly server boxes.'

const pageSeo: Record<string, { title: string, description: string, noindex?: boolean }> = {
  '/': {
    title: 'Remote Dev Boxes for AI Coding Agents',
    description: 'Create a named remote box, resume your local Claude or Codex session on it, disconnect, and let the agent keep working in a managed tmux session.',
  },
  '/getting-started': {
    title: 'Installation and First Box',
    description: 'Install the bh CLI, log in to a hosted or self-hosted backend, create your first remote box, and resume your local agent session on it.',
  },
  '/commands': {
    title: 'CLI Reference',
    description: 'Reference for every bh command: create, run, connect, sync, list, status, rename, move, destroy, image, team, login, logout, config, and version.',
  },
  '/teams': {
    title: 'Teams',
    description: 'Share boxes with teammates using team-owned boxes, owner/admin/member roles, shareable invite links, and per-team visibility.',
  },
  '/images': {
    title: 'Golden Images',
    description: 'Manage the golden VM images that new boxes boot from: list, snapshot, activate, deactivate, and remove images with bh image.',
  },
  '/providers': {
    title: 'Cloud Providers',
    description: 'Run DigitalOcean and Hetzner Cloud from one backend: provider credentials, regions, sizes, tiers, and golden snapshot configuration.',
  },
  '/self-hosting': {
    title: 'Self-Hosting Guide',
    description: 'Run the open-source BoxHaven backend yourself: local dev, Docker Compose, environment variables, production DigitalOcean deployment, and backups.',
  },
  '/security': {
    title: 'Security Model',
    description: 'How BoxHaven access works: short-lived SSH user certificates, the backend user CA, and exactly which credentials are forwarded to a box.',
  },
  '/overview': {
    title: 'Overview (Moved)',
    description: 'The BoxHaven overview moved to the documentation home page.',
    noindex: true,
  },
  '/operations': {
    title: 'Operations (Moved)',
    description: 'The BoxHaven operations guide moved into the self-hosting and images pages.',
    noindex: true,
  },
  '/404': {
    title: 'Page Not Found',
    description: 'The requested page could not be found on docs.boxhaven.dev.',
    noindex: true,
  },
}

function routeFromRelativePath(relativePath: string) {
  if (relativePath === 'index.md') {
    return '/'
  }

  return `/${relativePath.replace(/\.md$/, '')}`
}

function canonicalUrlForRoute(route: string) {
  if (route === '/') {
    return `${SITE_URL}/`
  }

  return `${SITE_URL}${route}`
}

function seoForPage(relativePath: string, fallbackTitle: string, fallbackDescription: string) {
  const route = routeFromRelativePath(relativePath)
  const override = pageSeo[route]

  return {
    route,
    title: override?.title ?? fallbackTitle,
    description: override?.description ?? (fallbackDescription || SITE_DESCRIPTION),
    canonicalUrl: canonicalUrlForRoute(route),
    noindex: override?.noindex ?? false,
  }
}

export default defineConfig({
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  sitemap: {
    hostname: SITE_URL,
    transformItems(items) {
      return items.filter((item) => !pageSeo[`/${item.url.replace(/\/$/, '')}`]?.noindex)
    },
  },

  vite: {
    server: {
      allowedHosts: ['localhost', 'host.docker.internal', 'boxhaven-docs-dev'],
    },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
  ],

  transformPageData(pageData) {
    const seo = seoForPage(
      pageData.relativePath,
      pageData.title || SITE_NAME,
      pageData.description || SITE_DESCRIPTION
    )

    return {
      title: seo.title,
      titleTemplate: `:title | ${SITE_NAME}`,
      description: seo.description,
    }
  },

  transformHead({ pageData, title, description }) {
    const seo = seoForPage(
      pageData.relativePath,
      pageData.title || SITE_NAME,
      pageData.description || SITE_DESCRIPTION
    )

    const head = [
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: SITE_NAME }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: seo.canonicalUrl }],
      ['meta', { property: 'og:image', content: SOCIAL_IMAGE_URL }],
      ['meta', { property: 'og:image:secure_url', content: SOCIAL_IMAGE_URL }],
      ['meta', { property: 'og:image:type', content: 'image/png' }],
      ['meta', { property: 'og:image:width', content: '720' }],
      ['meta', { property: 'og:image:height', content: '720' }],
      ['meta', { property: 'og:image:alt', content: SOCIAL_IMAGE_ALT }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
      ['meta', { name: 'twitter:url', content: seo.canonicalUrl }],
      ['meta', { name: 'twitter:domain', content: 'docs.boxhaven.dev' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: SOCIAL_IMAGE_URL }],
      ['meta', { name: 'twitter:image:alt', content: SOCIAL_IMAGE_ALT }],
    ]

    if (seo.noindex) {
      head.push(['meta', { name: 'robots', content: 'noindex, nofollow' }])
      return head
    }

    head.unshift(['link', { rel: 'canonical', href: seo.canonicalUrl }])
    return head
  },

  appearance: false,
  cleanUrls: true,

  markdown: {
    theme: 'github-dark',
  },

  themeConfig: {
    siteTitle: 'BoxHaven',
    logo: '/logo.png',

    nav: [
      { text: 'Get Started', link: '/getting-started' },
      { text: 'Commands', link: '/commands' },
      { text: 'Self-Hosting', link: '/self-hosting' },
      { text: 'Security', link: '/security' },
    ],

    sidebar: [
      {
        text: 'Start Here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'CLI Reference', link: '/commands' },
        ]
      },
      {
        text: 'Boxes & Teams',
        items: [
          { text: 'Teams', link: '/teams' },
          { text: 'Golden Images', link: '/images' },
          { text: 'Cloud Providers', link: '/providers' },
        ]
      },
      {
        text: 'Run Your Own',
        items: [
          { text: 'Self-Hosting', link: '/self-hosting' },
          { text: 'Security Model', link: '/security' },
          { text: 'Changelog', link: 'https://github.com/finbarr/boxhaven/blob/master/CHANGELOG.md' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/finbarr/boxhaven' }
    ],

    editLink: {
      pattern: 'https://github.com/finbarr/boxhaven/edit/master/docs/:path',
      text: 'Edit this page on GitHub'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2026 Finbarr Taylor'
    },

    search: {
      provider: 'local'
    },

    outline: {
      level: [2, 3],
      label: 'On this page'
    },
  }
})
