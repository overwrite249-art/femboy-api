import Link from "next/link";
import localFont from "next/font/local";
import { ArrowRight, ArrowUpRight, ChevronDown } from "lucide-react";
import {
  LandingExamples,
  LandingNavigation,
  LandingWordmark,
  ProductTour,
} from "./components/landing-interactive.tsx";
import styles from "./landing.module.css";

const sans = localFont({
  src: "../public/fonts/ibm-plex-sans-400-latin.woff2",
  weight: "400 600",
  display: "swap",
  variable: "--font-gateway-sans",
  fallback: ["Arial", "sans-serif"],
});
const mono = localFont({
  src: "../public/fonts/ibm-plex-mono-400-latin.woff2",
  weight: "400",
  display: "swap",
  variable: "--font-gateway-mono",
  fallback: ["Consolas", "monospace"],
});

export const metadata = {
  title: "Femboy API — A gateway you run yourself",
  description:
    "A self-hosted AI gateway for OpenAI, Anthropic, Gemini and compatible providers. Control routing, scoped keys and usage on your own Vercel and MongoDB stack.",
};
const repository = "https://github.com/overwrite249-art/femboy-api";
const faqs = [
  {
    question: "Is this a model subscription?",
    answer:
      "No. This is gateway software that you host. You bring your own provider accounts; model usage and hosting are billed separately by those services. No model credits are included.",
  },
  {
    question: "Can I use my existing SDK?",
    answer:
      "For OpenAI-compatible requests, change your client's base URL and use a gateway-issued key. Anthropic Messages and Gemini endpoints are also available. Supported features depend on the provider, model and gateway adapter you configure.",
  },
  {
    question: "Where are credentials stored?",
    answer:
      "Provider credentials are encrypted before database storage. Gateway keys are stored as digests, with the full value shown only when created or rotated. Server secrets belong in your hosting environment—not in source code or the public client.",
  },
  {
    question: "Do I need Redis?",
    answer:
      "No separate Redis account is required. MongoDB-only coordination supports shared limits, locks, queues and durable accounting. Use Atlas or a transaction-capable replica set. Upstash Redis remains an optional backend; the deployment documentation covers the tradeoffs.",
  },
  {
    question: "What is required for the first request?",
    answer:
      "Configure the server environment, bootstrap the root account from a trusted machine, and connect the maintenance scheduler. Then add a provider channel, fund a user's quota balance and create a scoped gateway key. There is no public first-admin signup.",
  },
  {
    question: "Can I modify the source?",
    answer:
      "Yes. Femboy API is MIT-licensed. You can inspect the implementation, run your own deployment and adapt it. Review the license, security documentation and your providers' terms before production use.",
  },
];

export default function LandingPage() {
  return (
    <div className={`${styles.site} ${sans.variable} ${mono.variable}`}>
      <a className="skip-link" href="#landing-content">
        Skip to content
      </a>
      <LandingNavigation />
      <main id="landing-content" tabIndex={-1}>
        <section
          className={`${styles.shell} ${styles.hero}`}
          aria-labelledby="hero-title"
        >
          <p className={styles.eyebrow}>
            <span className={styles.square} aria-hidden="true" /> Independent
            gateway software
          </p>
          <div className={styles.heroGrid}>
            <div>
              <h1 id="hero-title">
                Run your own
                <br />
                AI gateway.
              </h1>
              <p className={styles.heroLead}>
                One endpoint for your models. Routing, access and usage under
                your control.
              </p>
              <div className={styles.heroActions}>
                <Link href="/console" className={styles.primaryButton}>
                  Open console <ArrowRight size={18} />
                </Link>
                <Link href="/setup" className={styles.textLink}>
                  Deployment guide <ArrowUpRight size={17} />
                </Link>
              </div>
            </div>
            <aside
              className={styles.heroNote}
              aria-label="What you are deploying"
            >
              <span className={styles.marginLabel}>THE SHORT VERSION</span>
              <p>
                Bring your provider accounts.
                <br />
                Keep the infrastructure yours.
              </p>
              <dl>
                <div>
                  <dt>Runtime</dt>
                  <dd>Vercel</dd>
                </div>
                <div>
                  <dt>Storage</dt>
                  <dd>MongoDB</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>MIT licensed</dd>
                </div>
              </dl>
              <a
                href={repository}
                target="_blank"
                rel="noreferrer"
                className={styles.textLink}
              >
                Read the source <ArrowUpRight size={16} />
              </a>
            </aside>
          </div>
        </section>

        <section
          id="platform"
          className={`${styles.shell} ${styles.productSection}`}
          aria-labelledby="product-title"
        >
          <div className={styles.sectionBar}>
            <h2 id="product-title">Inside the gateway</h2>
            <span>Interactive example · not live workspace data</span>
          </div>
          <ProductTour />
        </section>

        <section
          className={`${styles.shell} ${styles.providers}`}
          aria-label="Supported provider connections"
        >
          <p>
            Connect the accounts
            <br className={styles.desktopBreak} /> you already use.
          </p>
          <ul>
            <li>OpenAI</li>
            <li>Anthropic</li>
            <li>Google Gemini</li>
            <li>OpenRouter</li>
            <li className={styles.compatible}>+ compatible APIs</li>
          </ul>
          <span className={styles.providerNote}>
            Independent software. No provider affiliation.
          </span>
        </section>

        <section
          id="control"
          className={`${styles.shell} ${styles.section} ${styles.ownership}`}
          aria-labelledby="control-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>01 / In your control</p>
            <h2 id="control-title">
              Infrastructure.
              <br />
              Not another
              <br className={styles.desktopBreak} /> subscription.
            </h2>
            <p>
              Use the gateway as part of your own stack. Provider accounts,
              access policy and deployment stay with you.
            </p>
          </div>
          <dl className={styles.ledger}>
            <div>
              <dt>
                <span>01</span>Provider credentials
              </dt>
              <dd>
                Encrypted before storage. Applications use separate gateway
                keys, scoped by model, expiration and IP—not your upstream
                credentials.
              </dd>
            </div>
            <div>
              <dt>
                <span>02</span>Quota &amp; usage
              </dt>
              <dd>
                Per-user balances and per-key quotas. Quota is reserved before a
                call and settled against recorded usage. Logs keep request
                metadata, not prompt content.
              </dd>
            </div>
            <div>
              <dt>
                <span>03</span>Your deployment
              </dt>
              <dd>
                Vercel and MongoDB, with an external maintenance scheduler. No
                separate Redis account required. Source and operational details
                are there to inspect.
              </dd>
            </div>
          </dl>
        </section>

        <section
          id="developers"
          className={styles.developerSection}
          aria-labelledby="developer-title"
        >
          <div className={`${styles.shell} ${styles.developerGrid}`}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>02 / Integration</p>
              <h2 id="developer-title">Keep your SDK.</h2>
              <p>
                Point an OpenAI client at your gateway. Use a configured model
                and a scoped key. The request format stays familiar.
              </p>
              <Link href="/console/docs" className={styles.textLink}>
                Read the API reference <ArrowUpRight size={17} />
              </Link>
              <div className={styles.protocolNote}>
                <span className={styles.marginLabel}>ALSO AVAILABLE</span>
                <p>
                  Anthropic Messages
                  <br />
                  Gemini content generation
                  <br />
                  Streaming on compatible models
                </p>
                <small>
                  Capabilities depend on your configured provider and adapter.
                </small>
              </div>
            </div>
            <LandingExamples />
          </div>
        </section>

        <section
          id="get-started"
          className={`${styles.shell} ${styles.section} ${styles.setupSection}`}
          aria-labelledby="setup-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>03 / Setup</p>
            <h2 id="setup-title">
              A small stack.
              <br />A deliberate setup.
            </h2>
            <p>
              Start with infrastructure, then connect the services your first
              request needs.
            </p>
            <Link href="/setup" className={styles.textLink}>
              Full deployment guide <ArrowUpRight size={17} />
            </Link>
          </div>
          <ol className={styles.setupSteps}>
            <li>
              <span>01</span>
              <div>
                <h3>Deploy the gateway</h3>
                <p>
                  Configure Vercel, MongoDB and server secrets. Bootstrap the
                  root account from a trusted machine.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Connect your services</h3>
                <p>
                  Set up the maintenance scheduler. Add a provider channel and
                  the models it can serve.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Send a real request</h3>
                <p>
                  Fund a user's quota balance, issue a gateway key, and try your
                  SDK or the playground.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section
          id="questions"
          className={`${styles.shell} ${styles.section} ${styles.faqSection}`}
          aria-labelledby="faq-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>A few practical details</p>
            <h2 id="faq-title">Before you deploy.</h2>
          </div>
          <div className={styles.faqList}>
            {faqs.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <ChevronDown size={17} />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <div className={`${styles.shell} ${styles.closingInner}`}>
            <div>
              <p className={styles.eyebrow}>OPEN SOURCE. SELF-HOSTED.</p>
              <h2 id="closing-title">Make it your gateway.</h2>
            </div>
            <Link href="/console" className={styles.primaryButton}>
              Open console <ArrowRight size={18} />
            </Link>
          </div>
        </section>
      </main>
      <footer className={`${styles.shell} ${styles.footer}`}>
        <div>
          <LandingWordmark />
          <p>An independent gateway for your provider accounts.</p>
        </div>
        <nav aria-label="Footer navigation">
          <a href={repository} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={15} />
          </a>
          <Link href="/setup">Deployment</Link>
          <a
            href={`${repository}/blob/main/docs/SECURITY.md`}
            target="_blank"
            rel="noreferrer"
          >
            Security notes <ArrowUpRight size={15} />
          </a>
          <a
            href={`${repository}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
          >
            MIT license <ArrowUpRight size={15} />
          </a>
        </nav>
        <p className={styles.footerNote}>
          Bring your own accounts. Review your providers' terms.
        </p>
        <a href="#landing-content" className={styles.backTop}>
          Back to top ↑
        </a>
      </footer>
    </div>
  );
}
