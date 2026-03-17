<script lang="ts">
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { accountsStore } from '$lib/stores/accounts.svelte'
  import routes from '$lib/routes'
  import SwarmLogo from '$lib/components/swarm-logo.svelte'
  import Button from '$lib/components/ui/button.svelte'
  import Typography from '$lib/components/ui/typography.svelte'
  import Vertical from '$lib/components/ui/vertical.svelte'
  import Horizontal from '$lib/components/ui/horizontal.svelte'
  import Grid from '$lib/components/ui/grid.svelte'
  import Code from 'carbon-icons-svelte/lib/Code.svelte'
  import Development from 'carbon-icons-svelte/lib/Development.svelte'
  import UserMultiple from 'carbon-icons-svelte/lib/UserMultiple.svelte'
  import Gateway from 'carbon-icons-svelte/lib/Gateway.svelte'
  import Db2DataSharingGroup from 'carbon-icons-svelte/lib/Db2DataSharingGroup.svelte'
  import Login from 'carbon-icons-svelte/lib/Login.svelte'
  import UserIdentification from 'carbon-icons-svelte/lib/UserIdentification.svelte'
  import ArrowRight from 'carbon-icons-svelte/lib/ArrowRight.svelte'

  const DOCS_URL = 'https://swarm-docs.snaha.net'

  const hasAccounts = $derived(accountsStore.accounts.length > 0)

  $effect(() => {
    if (hasAccounts) {
      goto(resolve(routes.HOME))
    }
  })
</script>

{#if !hasAccounts}
  <div class="product-page" data-theme="dark">
    <div class="hero-background"></div>
    <header class="header">
      <a href={resolve('/')} class="logo">
        <SwarmLogo fill="var(--colors-dark-top)" height={30} />
      </a>
      <Horizontal --horizontal-gap="var(--half-padding)">
        <Button variant="strong" dimension="compact" mode="dark" href={resolve(routes.ACCOUNT_NEW)}>
          Create identity
        </Button>
        <span class="docs-link">
          <Button
            variant="secondary"
            dimension="compact"
            mode="dark"
            href={DOCS_URL}
            target="_blank"
          >
            Documentation
          </Button>
        </span>
      </Horizontal>
    </header>

    <main class="main">
      <section class="hero">
        <div class="hero-content">
          <Typography variant="h1" class="hero-title">The Identity System for Swarm</Typography>
          <Typography class="hero-subtitle">
            Swarm ID gives Web3 apps a decentralized identity layer with built-in access control and
            monetization capabilities.
          </Typography>
          <Horizontal --horizontal-gap="var(--padding)">
            <Button
              variant="strong"
              dimension="default"
              mode="dark"
              href={resolve(routes.ACCOUNT_NEW)}
            >
              Create identity
            </Button>
            <Button
              variant="secondary"
              dimension="default"
              mode="dark"
              href={DOCS_URL}
              target="_blank"
            >
              Read the docs
              <ArrowRight size={20} />
            </Button>
          </Horizontal>
        </div>
      </section>

      <section class="features">
        <div class="feature-cards">
          <div class="feature-card">
            <div class="feature-icon">
              <Code size={32} />
            </div>
            <Typography variant="h4">For Developers</Typography>
            <Typography variant="large" class="feature-tagline" accent>
              Build Web3 apps without the infrastructure headaches.
            </Typography>
            <Typography class="feature-body">
              Swarm ID provides a simple authentication layer and access control system that handles
              the complexity of Swarm's infrastructure for you. With secure key management and
              portable postage stamps, you can just focus on building great apps.
            </Typography>
          </div>

          <div class="feature-card">
            <div class="feature-icon">
              <Development size={32} />
            </div>
            <Typography variant="h4">For Content Creators</Typography>
            <Typography variant="large" class="feature-tagline" accent>
              Upload content to Swarm and share on your terms.
            </Typography>
            <Typography class="feature-body">
              Swarm ID's built-in authentication layer lets you monetize access to your content
              while maintaining permissionless, censorship-resistant sharing through Swarm. Accept
              flexible on-chain payments and keep full control of your work without intermediaries.
            </Typography>
          </div>

          <div class="feature-card">
            <div class="feature-icon">
              <UserMultiple size={32} />
            </div>
            <Typography variant="h4">For Users</Typography>
            <Typography variant="large" class="feature-tagline" accent>
              Connect to Web3 apps with advanced privacy controls.
            </Typography>
            <Typography class="feature-body">
              Create specific, private identities for each app you use, authenticate with your
              Ethereum wallet or Passkey, and sync your account across multiple devices. You control
              your data and identities without trusting centralized platforms.
            </Typography>
          </div>
        </div>
      </section>

      <section class="benefits">
        <Grid
          cssGridTemplateColumns="1fr 1fr"
          cssGap="var(--double-padding)"
          cssAlignItems="start"
          class="benefits-grid"
        >
          <div class="benefit-item">
            <div class="benefit-icon">
              <Gateway size={48} />
            </div>
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="h4">Easy Swarm Integration</Typography>
              <Typography class="benefit-body">
                Handle user authentication, manage access control, and work with postage stamps
                through clean, well-documented interfaces. Spend less time on infrastructure
                plumbing and more time shipping features your users will love.
              </Typography>
            </Vertical>
          </div>

          <div class="benefit-item">
            <div class="benefit-icon">
              <Db2DataSharingGroup size={48} />
            </div>
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="h4">Permissionless Sharing with Full Control</Typography>
              <Typography class="benefit-body">
                Swarm ID offers a flexible access control and monetization layer that's easy to
                integrate into decentralized apps, letting creators and developers build sustainable
                businesses without platform fees or arbitrary restrictions.
              </Typography>
            </Vertical>
          </div>

          <div class="benefit-item">
            <div class="benefit-icon">
              <Login size={48} />
            </div>
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="h4">Sign Up with Ethereum Wallet or Passkey</Typography>
              <Typography class="benefit-body">
                Getting started is simple, anyone can create an account with an existing Ethereum
                wallet or Passkey. Users get full privacy—no email verification, no personal
                information required, and no centralized authority controlling access.
              </Typography>
            </Vertical>
          </div>

          <div class="benefit-item">
            <div class="benefit-icon">
              <UserIdentification size={48} />
            </div>
            <Vertical --vertical-gap="var(--half-padding)">
              <Typography variant="h4">One Place for All Your Identities</Typography>
              <Typography class="benefit-body">
                Create and manage separate identities for each app you use—without linking your
                activities across different services. Swarm ID offers the privacy protection of
                multiple accounts with the convenience of a single interface.
              </Typography>
            </Vertical>
          </div>
        </Grid>
      </section>
    </main>
  </div>
{/if}

<style>
  .product-page {
    --font-family-sans-serif: var(--font-family-inter);
    --font-family-h1: var(--font-family-inter);
    --font-family-h2: var(--font-family-inter);
    --font-family-h3: var(--font-family-inter);
    --font-family-h4: var(--font-family-inter);
    --font-family-h5: var(--font-family-inter);
    --font-family-h6: var(--font-family-inter);
    font-family: var(--font-family-inter);
    min-height: 100vh;
    background: #0e1215;
    color: var(--colors-dark-ultra-high);
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--double-padding);
    max-width: 1200px;
    margin: 0 auto;
  }

  @media screen and (max-width: 900px) {
    .header {
      padding: var(--padding);
    }
  }

  .logo {
    display: flex;
    align-items: center;
    z-index: 1;
  }

  .main {
    display: flex;
    flex-direction: column;
    gap: var(--quadruple-padding);
    /* max-width: 1200px; */
    margin: 0 auto;
    padding: 0 var(--double-padding);
    /* Desktop: 320px from top - 106px header = 214px */
    margin-top: 214px;
  }

  @media screen and (max-width: 900px) {
    .main {
      /* Mobile: hero scales with viewport width (442/1366 ≈ 32.36vw), minus header */
      margin-top: calc(32.36vw - 106px);
      padding: 0 var(--padding);
    }

    .docs-link {
      display: none;
    }
  }

  .hero {
    position: relative;
  }

  .hero-background {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 100%;
    max-width: 1366px;
    height: 442px;
    background-image: url('/swarmid_hero_bg.svg');
    background-size: contain;
    background-repeat: no-repeat;
    background-position: top center;
    pointer-events: none;
  }

  .hero-content {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: var(--padding);
    margin: 0 auto;
  }

  :global(.hero-title) {
    color: var(--colors-dark-top);
  }

  :global(.hero-subtitle) {
    color: var(--colors-dark-high);
    max-width: 560px;
    font-size: 24px !important;
    line-height: 40px !important;
    letter-spacing: 0% !important;
  }

  @media screen and (max-width: 900px) {
    :global(.hero-title) {
      font-size: 32px !important;
      line-height: 40px !important;
    }

    :global(.hero-subtitle) {
      font-size: 24px !important;
      line-height: 32px !important;
    }
  }

  .feature-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--padding);
  }

  @media screen and (max-width: 900px) {
    .feature-cards {
      grid-template-columns: 1fr;
    }
  }

  .feature-card {
    background: #212830;
    border: 1px solid #2f3842;
    border-radius: 16px;
    padding: var(--double-padding);
    display: flex;
    flex-direction: column;
    gap: var(--half-padding);
  }

  .feature-icon {
    color: var(--colors-ultra-high);
  }

  :global(.feature-tagline) {
    color: var(--colors-high);
  }

  :global(.feature-body) {
    color: var(--colors-dark-high);
  }

  .benefits {
    max-width: calc(var(--double-padding) + 2 * 560px);
    margin: auto;
  }

  :global(.benefits-grid) {
    align-items: start;
  }

  @media screen and (max-width: 768px) {
    :global(.benefits-grid) {
      grid-template-columns: 1fr !important;
    }
  }

  .benefit-item {
    display: flex;
    gap: var(--padding);
    align-items: flex-start;
    flex-direction: column;
  }

  .benefit-icon {
    color: var(--colors-dark-high);
    flex-shrink: 0;
  }

  :global(.benefit-body) {
    color: var(--colors-dark-high);
  }
</style>
