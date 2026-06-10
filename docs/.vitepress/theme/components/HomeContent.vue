<template>
  <div class="home-content">
    <!-- ── Masthead ── -->
    <section class="home-section masthead-section">
      <div class="section-inner masthead-inner">
        <img class="masthead-logo" src="/logo.png" alt="The BoxHaven logo: a cozy wooden house sheltering three friendly server boxes." width="180" height="180" />
        <div class="masthead-copy">
          <h1 class="masthead-title">BoxHaven</h1>
          <p class="masthead-tagline">
            Remote dev boxes for AI coding agents. Create a box, resume your
            agent session on it, disconnect, let it work.
          </p>
          <div class="install-line">
            <code>curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh</code>
          </div>
        </div>
      </div>
    </section>

    <!-- ── The Workflow ── -->
    <section class="home-section workflow-section">
      <div class="section-inner">
        <div class="section-label">The Workflow</div>
        <h2 class="section-title">Close the laptop. The agent keeps cooking.</h2>
        <p class="section-desc">
          Copy your project to a box once, start Claude or Codex inside the
          box's tmux session — resuming your local conversation if you like —
          then disconnect and let it work.
        </p>
        <div class="workflow-terminal">
          <div class="term">
            <div class="term-header">
              <span class="dot dot-ember"></span>
              <span class="dot dot-lantern"></span>
              <span class="dot dot-leaf"></span>
              <span class="term-title">bh</span>
            </div>
            <div class="term-body">
              <div class="term-line"><span class="prompt">$</span> bh create work <span class="comment"># provisions the box and syncs this project once</span></div>
              <div class="term-line"><span class="prompt">$</span> bh run work claude <span class="comment"># claude starts in the box's tmux session</span></div>
              <div class="term-line"><span class="output">Claude&gt; On it.</span></div>
              <div class="term-line"><span class="prompt">$</span> <span class="comment"># close the laptop — the agent keeps working</span></div>
              <div class="term-line"><span class="prompt">$</span> bh connect work <span class="comment"># reattach any time</span></div>
            </div>
          </div>
        </div>
        <div class="quickstart-cta">
          <a href="/getting-started" class="cta-docs">Get started</a>
        </div>
      </div>
    </section>

    <!-- ── Features ── -->
    <section class="home-section features-section">
      <div class="section-inner">
        <div class="section-label">What You Get</div>
        <h2 class="section-title">Everything teams keep rebuilding by hand</h2>
        <div class="feature-grid">
          <div class="feature-card" v-for="feature in features" :key="feature.title">
            <div class="feature-icon">{{ feature.icon }}</div>
            <h3>{{ feature.title }}</h3>
            <p>{{ feature.copy }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Guide Grid ── -->
    <section class="home-section guide-section">
      <div class="section-inner">
        <div class="section-label">Find the Right Page</div>
        <h2 class="section-title">Start with the task you are trying to solve</h2>
        <div class="guide-grid">
          <a v-for="guide in guides" :key="guide.title" :href="guide.href" class="guide-card">
            <div class="guide-kicker">{{ guide.kicker }}</div>
            <h3>{{ guide.title }}</h3>
            <p>{{ guide.copy }}</p>
          </a>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
const features = [
  {
    icon: '📦',
    title: 'Sessions that survive disconnect',
    copy: 'Each box keeps a managed tmux session for long-running Claude, Codex, Gemini, or shell work. Boxes stay alive while laptops sleep.',
  },
  {
    icon: '💬',
    title: 'Resume your local conversation',
    copy: 'Starting claude or codex forwards your newest local sessions for the project, so claude --continue on the box picks up exactly where your laptop left off.',
  },
  {
    icon: '🏠',
    title: 'Team-owned boxes',
    copy: 'Every box belongs to a team with owner, admin, and member roles, shareable invite links, and per-team visibility.',
  },
  {
    icon: '🖼️',
    title: 'Golden images',
    copy: 'Boxes boot from a prebuilt snapshot with the agent runtime already installed. Admins snapshot a prepared box and activate it for the whole backend.',
  },
  {
    icon: '☁️',
    title: 'Multi-provider',
    copy: 'One backend serves DigitalOcean and Hetzner Cloud at once. Pick a provider, region, and image per create, or rely on the backend default.',
  },
  {
    icon: '🔧',
    title: 'Self-hostable',
    copy: 'The open-source Fastify/Better Auth control plane runs with your own provider credentials and no built-in limits.',
  },
]

const guides = [
  {
    kicker: 'Install',
    title: 'Get running fast',
    href: '/getting-started',
    copy: 'Install the bh CLI, log in, create your first box, and resume an agent session on it.',
  },
  {
    kicker: 'Reference',
    title: 'Find the exact command',
    href: '/commands',
    copy: 'Every bh command and flag: create, run, connect, sync, image, team, and more.',
  },
  {
    kicker: 'Collaborate',
    title: 'Share boxes with a team',
    href: '/teams',
    copy: 'Create teams, send invite links, control roles, and move boxes between teams.',
  },
  {
    kicker: 'Providers',
    title: 'Pick your cloud',
    href: '/providers',
    copy: 'Configure DigitalOcean and Hetzner Cloud credentials, regions, sizes, and tiers.',
  },
  {
    kicker: 'Operate',
    title: 'Run your own backend',
    href: '/self-hosting',
    copy: 'Local dev, Docker Compose, environment variables, production deploy, and backups.',
  },
  {
    kicker: 'Security',
    title: 'Understand the boundary',
    href: '/security',
    copy: 'Short-lived SSH certificates, the backend user CA, and exactly what gets forwarded to a box.',
  },
]
</script>

<style scoped>
/* ── Layout ── */
.home-content {
  width: 100%;
  overflow: hidden;
}

.home-section {
  padding: 80px 24px;
  position: relative;
}

.home-section + .home-section {
  border-top: 1px solid var(--vp-c-divider);
}

.section-inner {
  max-width: 960px;
  margin: 0 auto;
}

/* ── Masthead ── */
.masthead-section {
  padding-top: 64px;
  padding-bottom: 48px;
}

.masthead-section + .home-section {
  border-top: none;
}

.masthead-inner {
  display: flex;
  align-items: center;
  gap: 40px;
}

.masthead-logo {
  width: 180px;
  height: 180px;
  flex-shrink: 0;
  border: 1px solid var(--bhv-wood-border);
  border-radius: 8px;
  background: var(--bhv-parchment);
  box-shadow: var(--bhv-card-shadow-hover);
  padding: 12px;
}

.masthead-title {
  font-weight: 800;
  font-size: clamp(2.2rem, 6vw, 3rem);
  letter-spacing: -0.03em;
  line-height: 1.1;
  color: var(--bhv-ink-strong);
  margin: 0 0 12px;
}

.masthead-tagline {
  font-size: 1.15rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 540px;
  margin: 0 0 20px;
}

.install-line code {
  display: inline-block;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  color: var(--bhv-terminal-text);
  background: var(--bhv-terminal-bg);
  border: 1px solid var(--bhv-terminal-border);
  border-radius: 8px;
  padding: 10px 16px;
  box-shadow: var(--bhv-card-shadow);
}

/* ── Section Headings ── */
.section-label {
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--bhv-green);
  text-transform: uppercase;
  letter-spacing: 0.15em;
  margin-bottom: 16px;
}

.section-title {
  font-weight: 800;
  font-size: clamp(1.6rem, 4vw, 2.25rem);
  line-height: 1.2;
  letter-spacing: -0.03em;
  margin-bottom: 16px;
  color: var(--bhv-ink-strong);
}

.section-desc {
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  max-width: 620px;
  line-height: 1.7;
}

/* ── Terminal Block ── */
.workflow-terminal {
  max-width: 720px;
  margin-top: 32px;
}

.term {
  background: var(--bhv-terminal-bg);
  border: 1px solid var(--bhv-terminal-border);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--bhv-card-shadow);
  transition: border-color 0.3s, box-shadow 0.3s;
}

.term:hover {
  border-color: var(--bhv-wood-border-strong);
  box-shadow: var(--bhv-card-shadow-hover);
}

.term-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bhv-terminal-header-bg);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
}
.dot-ember { background: var(--bhv-ember); }
.dot-lantern { background: var(--bhv-lantern); }
.dot-leaf { background: var(--bhv-leaf); }

.term-title {
  margin-left: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  color: var(--bhv-terminal-faint);
}

.term-body {
  padding: 20px 24px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.85;
  color: var(--bhv-terminal-text);
}

.term-body .prompt { color: var(--bhv-leaf); }
.term-body .comment { color: var(--bhv-terminal-faint); }
.term-body .output { color: var(--bhv-terminal-muted); }

.quickstart-cta {
  margin-top: 28px;
}

.cta-docs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--bhv-green) !important;
  border-bottom: 1px solid rgba(47, 111, 92, 0.3) !important;
  padding-bottom: 2px;
  transition: all 0.2s;
  text-decoration: none !important;
}

.cta-docs:hover {
  color: var(--bhv-green-deep) !important;
  border-bottom-color: var(--bhv-green-deep) !important;
}

.cta-docs::after {
  content: '\2192';
}

/* ── Feature Grid ── */
.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin-top: 32px;
}

.feature-card {
  padding: 26px 24px;
  background: var(--bhv-panel);
  border: 1px solid var(--bhv-wood-border);
  border-radius: 8px;
  box-shadow: var(--bhv-card-shadow);
  transition: border-color 0.3s, transform 0.3s, box-shadow 0.3s;
}

.feature-card:hover {
  border-color: var(--bhv-accent-border-strong);
  transform: translateY(-3px);
  box-shadow: var(--bhv-card-shadow-hover);
}

.feature-icon {
  font-size: 1.6rem;
  line-height: 1;
  margin-bottom: 14px;
}

.feature-card h3 {
  font-weight: 700;
  font-size: 1.05rem;
  margin: 0 0 10px;
  letter-spacing: -0.02em;
  color: var(--bhv-ink-strong);
}

.feature-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.65;
}

/* ── Guide Grid ── */
.guide-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin-top: 32px;
}

.guide-card {
  display: block;
  padding: 22px;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
  background: var(--bhv-panel);
  border: 1px solid var(--bhv-wood-border);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.guide-card:hover {
  transform: translateY(-2px);
  border-color: var(--bhv-accent-border-strong);
  box-shadow: var(--bhv-card-shadow-hover);
}

.guide-kicker {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--bhv-green);
  margin-bottom: 10px;
}

.guide-card h3 {
  margin: 0 0 10px;
  font-size: 1.05rem;
  color: var(--bhv-ink-strong);
}

.guide-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  font-size: 0.9rem;
}

/* ── Responsive ── */
@media (max-width: 768px) {
  .masthead-inner {
    flex-direction: column;
    align-items: flex-start;
    gap: 24px;
  }

  .masthead-logo {
    width: 132px;
    height: 132px;
  }

  .install-line code {
    font-size: 0.72rem;
    white-space: normal;
    word-break: break-all;
  }

  .feature-grid,
  .guide-grid {
    grid-template-columns: 1fr;
  }

  .term-body {
    font-size: 0.75rem;
    padding: 16px;
  }

  .home-section {
    padding: 60px 24px;
  }
}
</style>
