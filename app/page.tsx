import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Database,
  KeyRound,
  Layers3,
  LockKeyhole,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Wallet,
} from "lucide-react";
import { Brand } from "./components/interface.tsx";
import {
  LandingExamples,
  LandingNavigation,
  ProductTour,
} from "./components/landing-interactive.tsx";
import styles from "./landing.module.css";

export const metadata = {
  title: "Femboy API — Build beyond one model",
  description:
    "Bring OpenAI, Anthropic, Gemini and compatible providers behind one API. A self-hosted gateway for routing, scoped access and usage visibility.",
};

const repository = "https://github.com/overwrite249-art/femboy-api";
const faqs = [
  {
    question: "Is this another AI model subscription?",
    answer:
      "No. Femboy API is a self-hosted gateway, not a model provider. Bring your own provider accounts and infrastructure. Provider usage and hosting costs are separate; the gateway does not include model credits.",
  },
  {
    question: "Can I keep using my existing SDK?",
    answer:
      "For OpenAI-compatible integrations, point the SDK’s base URL at your gateway and use a gateway-issued API key. The gateway also exposes Anthropic Messages and Gemini endpoints. Model features and compatibility depend on your configured provider and its adapter.",
  },
  {
    question: "Where do my API keys live?",
    answer:
      "Provider credentials are encrypted before database storage. Gateway keys are stored as digests and shown only when created or rotated. Server secrets belong in your hosting environment, not your repository or public application code.",
  },
  {
    question: "Do I need a Redis account?",
    answer:
      "No. MongoDB-only coordination is supported for shared limits, locks, queues and durable accounting. You need Atlas or a transaction-capable MongoDB replica set. Upstash Redis is optional; the deployment guide explains the operational tradeoffs.",
  },
  {
    question: "What do I need before my first request?",
    answer:
      "Configure your hosting environment, establish the root account with the documented operator-only bootstrap command, and connect the maintenance scheduler. Then add a provider channel, fund a user’s quota balance and issue a scoped gateway key. There is no public first-administrator signup.",
  },
  {
    question: "Can I inspect and change the source?",
    answer:
      "Yes. The project is MIT-licensed. You can inspect the implementation, host your own deployment and adapt it to your workflow. Review the license, security notes and provider terms before production use.",
  },
];

export default function LandingPage() {
  return (
    <div className={styles.site}>
      <a className="skip-link" href="#landing-content">
        Skip to content
      </a>
      <div className={styles.navigationShell}>
        <LandingNavigation />
      </div>
      <main id="landing-content">
        <div className={styles.hero}>
          <img
            className={styles.heroArt}
            src="/images/gateway-flow.webp"
            width={1600}
            height={656}
            alt=""
            fetchPriority="high"
            decoding="async"
          />
          <section className={styles.heroContent} aria-labelledby="hero-title">
            <div className={styles.releaseLabel}>
              <span className={styles.releaseMark} aria-hidden="true">
                <Layers3 size={15} />
              </span>
              INDEPENDENT AI INFRASTRUCTURE
              <span className={styles.labelLine} aria-hidden="true" />
            </div>
            <h1 id="hero-title">
              Build beyond
              <span>one model.</span>
            </h1>
            <p className={styles.heroLead}>
              Your favorite providers. One familiar API. <br />
              Route requests, control access, and keep usage in view—from a
              gateway you host.
            </p>
            <div className={styles.heroActions}>
              <Link href="/console" className={styles.buttonWhite}>
                Open your console <ArrowUpRight size={18} />
              </Link>
              <a href="#platform" className={styles.buttonGlass}>
                Take a product tour <ArrowDown size={17} />
              </a>
            </div>
            <ul className={styles.heroPromises} aria-label="Gateway principles">
              <li>
                <Check size={15} /> Self-hosted
              </li>
              <li>
                <Check size={15} /> Open source
              </li>
              <li>
                <Check size={15} /> Your provider accounts
              </li>
            </ul>
            <div
              className={styles.heroFlow}
              aria-label="Your application connects to your providers through Femboy API"
            >
              <div className={styles.flowEndpoint}>
                <Code2 size={18} />
                <span>Your app</span>
              </div>
              <div className={styles.flowConnector} aria-hidden="true">
                <span />
                <ArrowRight size={16} />
              </div>
              <div className={styles.flowGateway}>
                <Layers3 size={22} />
                <span>femboy / api</span>
              </div>
              <div className={styles.flowConnector} aria-hidden="true">
                <span />
                <ArrowRight size={16} />
              </div>
              <div className={styles.flowEndpoint}>
                <Server size={18} />
                <span>Your models</span>
              </div>
            </div>
            <div className={styles.heroBottom}>
              <span>ONE CONNECTION. MORE POSSIBILITIES.</span>
              <a href="#platform">
                Discover the gateway <ArrowDown size={15} />
              </a>
            </div>
          </section>
        </div>

        <div className={styles.providers}>
          <div className={styles.container}>
            <p>Bring the providers you already build with.</p>
            <div
              className={styles.providerNames}
              aria-label="Supported provider families"
            >
              <span>OpenAI</span>
              <span className={styles.anthropicName}>Anthropic</span>
              <span>
                Google <strong>Gemini</strong>
              </span>
              <span>OpenRouter</span>
              <span className={styles.compatible}>+ compatible APIs</span>
            </div>
            <span className={styles.providerDisclaimer}>
              Independent gateway. No provider affiliation.
            </span>
          </div>
        </div>

        <section
          className={`${styles.section} ${styles.platform}`}
          id="platform"
          aria-labelledby="platform-title"
        >
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>01 / THE CONTROL PLANE</span>
                <h2 id="platform-title">
                  Less plumbing.
                  <br />
                  More possibility.
                </h2>
              </div>
              <p>
                A focused workspace for the moving parts of your AI stack.
                Connect a provider, scope a key, and see what happens next.
              </p>
            </div>
            <ProductTour />
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.controlSection}`}
          id="control"
          aria-labelledby="control-title"
        >
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>02 / BUILT TO BE YOURS</span>
                <h2 id="control-title">Control isn’t an add-on.</h2>
              </div>
              <p>
                Your infrastructure, your access rules, your view of usage.
                Deliberate controls from the first request.
              </p>
            </div>
            <div className={styles.featureGrid}>
              <article className={styles.privacyCard}>
                <div className={styles.featureIcon}>
                  <LockKeyhole size={23} />
                </div>
                <span className={styles.featureEyebrow}>
                  ACCESS, WITH INTENTION
                </span>
                <h3>
                  Keep the keys.
                  <br />
                  Share the possibilities.
                </h3>
                <p>
                  Give each application its own gateway key. Keep provider
                  credentials separate, with model scopes, expiry and IP
                  restrictions.
                </p>
                <div
                  className={styles.keyIllustration}
                  aria-label="Gateway keys can be scoped independently from provider credentials"
                >
                  <div>
                    <KeyRound size={18} />
                    <code>FEMBOY_API_KEY</code>
                    <ShieldCheck size={18} />
                  </div>
                  <ul>
                    <li>
                      <Check size={14} /> Model scope
                    </li>
                    <li>
                      <Check size={14} /> Expiry
                    </li>
                    <li>
                      <Check size={14} /> IP restrictions
                    </li>
                  </ul>
                </div>
                <Link href="/console/tokens" className={styles.lightLink}>
                  Explore API keys <ArrowUpRight size={17} />
                </Link>
              </article>
              <article className={styles.budgetCard}>
                <div className={styles.featureIcon}>
                  <Wallet size={23} />
                </div>
                <div>
                  <span className={styles.featureEyebrow}>
                    SPEND, ON PURPOSE
                  </span>
                  <h3>
                    Make every request
                    <br />
                    accountable.
                  </h3>
                  <p>
                    Per-user balances and token quotas, backed by transactional
                    accounting and request-level usage metadata.
                  </p>
                </div>
                <div
                  className={styles.accountingFlow}
                  aria-label="Quota is reserved before a request and settled against usage"
                >
                  <span>Reserve</span>
                  <ArrowRight size={15} />
                  <span>Request</span>
                  <ArrowRight size={15} />
                  <span>Settle</span>
                </div>
                <Link href="/console/usage" className={styles.textLink}>
                  Understand usage <ArrowUpRight size={17} />
                </Link>
              </article>
              <article className={styles.infrastructureCard}>
                <div className={styles.infrastructureIcons} aria-hidden="true">
                  <Server size={26} />
                  <span>+</span>
                  <Database size={26} />
                </div>
                <div>
                  <span className={styles.featureEyebrow}>
                    A STACK YOU CAN UNDERSTAND
                  </span>
                  <h3>
                    Vercel. MongoDB.
                    <br />
                    Room to make it yours.
                  </h3>
                  <p>
                    No separate Redis account required. Your deployment, with an
                    external maintenance scheduler and source you can inspect.
                  </p>
                </div>
                <Link href="/setup" className={styles.textLink}>
                  See the deployment guide <ArrowUpRight size={17} />
                </Link>
              </article>
            </div>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.developerSection}`}
          id="developers"
          aria-labelledby="developers-title"
        >
          <div className={`${styles.container} ${styles.developerLayout}`}>
            <div className={styles.developerCopy}>
              <span className={styles.eyebrow}>03 / DEVELOPER FIRST</span>
              <h2 id="developers-title">
                A familiar API.
                <br />A wider horizon.
              </h2>
              <p>
                Keep the SDK you know. Point it at your gateway, choose a
                configured model, and get back to what you’re building.
              </p>
              <ul className={styles.checkList}>
                <li>
                  <Check size={17} /> OpenAI-compatible requests
                </li>
                <li>
                  <Check size={17} /> Anthropic and Gemini dialects
                </li>
                <li>
                  <Check size={17} /> Streaming on compatible models
                </li>
              </ul>
              <Link href="/console/docs" className={styles.buttonPrimary}>
                <BookOpen size={17} /> Read the API reference{" "}
                <ArrowUpRight size={16} />
              </Link>
              <p className={styles.smallNote}>
                Model capabilities depend on your provider and configuration.
                Keep API keys in your server environment.
              </p>
            </div>
            <LandingExamples />
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.launchSection}`}
          id="get-started"
          aria-labelledby="launch-title"
        >
          <div className={styles.container}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>04 / YOUR FIRST REQUEST</span>
                <h2 id="launch-title">
                  From your stack
                  <br />
                  to your next idea.
                </h2>
              </div>
              <Link href="/setup" className={styles.textLink}>
                Follow the full setup guide <ArrowUpRight size={18} />
              </Link>
            </div>
            <ol className={styles.launchSteps}>
              <li>
                <span className={styles.stepNumber}>01</span>
                <Server size={24} />
                <h3>Make it yours.</h3>
                <p>
                  Configure Vercel, MongoDB and server secrets. Establish your
                  root account through the trusted bootstrap workflow.
                </p>
              </li>
              <li>
                <span className={styles.stepNumber}>02</span>
                <SlidersHorizontal size={24} />
                <h3>Connect your stack.</h3>
                <p>
                  Set up maintenance jobs, connect a provider channel, and
                  choose the models and routing rules you want.
                </p>
              </li>
              <li>
                <span className={styles.stepNumber}>03</span>
                <Terminal size={24} />
                <h3>Build your next thing.</h3>
                <p>
                  Fund a user’s quota balance, create a scoped gateway key, and
                  send your first request with the playground or your SDK.
                </p>
              </li>
            </ol>
          </div>
        </section>

        <section
          className={`${styles.section} ${styles.faqSection}`}
          id="questions"
          aria-labelledby="faq-title"
        >
          <div className={`${styles.container} ${styles.faqLayout}`}>
            <div>
              <span className={styles.eyebrow}>A FEW THINGS TO KNOW</span>
              <h2 id="faq-title">
                Good questions.
                <br />
                Straight answers.
              </h2>
              <p className={styles.faqIntro}>
                A gateway should make your stack clearer—not leave you guessing.
              </p>
              <a
                href={`${repository}/tree/main/docs`}
                className={styles.textLink}
                target="_blank"
                rel="noreferrer"
              >
                Explore the documentation <ArrowUpRight size={17} />
              </a>
            </div>
            <div className={styles.faqList}>
              {faqs.map((faq) => (
                <details key={faq.question} className={styles.faqItem}>
                  <summary>
                    {faq.question}
                    <ChevronDown size={19} />
                  </summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.finalSection} aria-labelledby="final-title">
          <div className={`${styles.container} ${styles.finalCard}`}>
            <div className={styles.finalCopy}>
              <span className={styles.finalEyebrow}>
                <Layers3 size={18} /> YOUR AI, CONNECTED.
              </span>
              <h2 id="final-title">
                The next thing
                <br />
                is yours to build.
              </h2>
              <p>Start with your providers. Make the gateway your own.</p>
            </div>
            <div className={styles.finalActions}>
              <Link href="/console" className={styles.buttonWhite}>
                Open your console <ArrowUpRight size={18} />
              </Link>
              <a
                href={repository}
                className={styles.buttonGlass}
                target="_blank"
                rel="noreferrer"
              >
                <Code2 size={18} /> Explore the source
              </a>
              <span>MIT-licensed. Independently yours.</span>
            </div>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerGrid}`}>
          <div className={styles.footerBrand}>
            <Link href="/" aria-label="femboy api home">
              <Brand />
            </Link>
            <p>
              One gateway for the things
              <br />
              you haven’t built yet.
            </p>
          </div>
          <div className={styles.footerLinks}>
            <h3>Platform</h3>
            <a href="#platform">Product tour</a>
            <Link href="/console/playground">Playground</Link>
            <Link href="/console">Console</Link>
          </div>
          <div className={styles.footerLinks}>
            <h3>Build</h3>
            <Link href="/console/docs">API reference</Link>
            <Link href="/setup">Deployment guide</Link>
            <a
              href={`${repository}/blob/main/docs/SECURITY.md`}
              target="_blank"
              rel="noreferrer"
            >
              Security notes <ArrowUpRight size={13} />
            </a>
          </div>
          <div className={styles.footerLinks}>
            <h3>Project</h3>
            <a href={repository} target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight size={13} />
            </a>
            <a
              href={`${repository}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer"
            >
              MIT license <ArrowUpRight size={13} />
            </a>
            <a href="#questions">Questions</a>
          </div>
        </div>
        <div className={`${styles.container} ${styles.footerBottom}`}>
          <span>femboy / api</span>
          <span>
            Independent project. Bring your own accounts and review provider
            terms.
          </span>
          <a href="#landing-content">
            Back to top <ArrowUpRight size={14} />
          </a>
        </div>
      </footer>
    </div>
  );
}
