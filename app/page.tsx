import Link from "next/link";
import {
  ArrowRight,
  ChevronDown,
  KeyRound,
  PiggyBank,
  ReceiptText,
  Route,
} from "lucide-react";
import {
  LandingExamples,
  LandingNavigation,
  LandingWordmark,
  RouteDemo,
} from "./components/landing-interactive.tsx";
import styles from "./landing.module.css";

export const metadata = {
  title: "Femboy API — one key in, every model out",
  description:
    "A self-hosted AI gateway for OpenAI, Anthropic, Gemini and compatible providers. Route requests, issue scoped keys and track quota on your own Vercel and MongoDB deployment.",
};

const repository = "https://github.com/overwrite249-art/femboy-api";

const stages = [
  {
    name: "Scope",
    icon: KeyRound,
    text: "Check the gateway key: is the model allowed, is the key still live, is the caller's address in range.",
  },
  {
    name: "Reserve",
    icon: PiggyBank,
    text: "Hold quota against the owner's balance before anything leaves your deployment.",
  },
  {
    name: "Route",
    icon: Route,
    text: "Elect a healthy channel by priority, then by weight, and translate the request into that provider's dialect.",
  },
  {
    name: "Settle",
    icon: ReceiptText,
    text: "Record what the call used and settle the hold. Request metadata is kept; prompts are not archived.",
  },
];

const ownership = [
  {
    title: "Keys stay separated",
    image: "/images/key-tag.webp",
    width: 560,
    height: 469,
    text: "Provider credentials are encrypted before storage. Applications get their own gateway keys, scoped by model, expiry and address, so no app ever holds your upstream credential.",
  },
  {
    title: "Spending is reserved, then settled",
    image: "/images/coin-jar.webp",
    width: 560,
    height: 361,
    text: "Every user has a balance and every key can carry its own limit. Quota is held before the call and settled against recorded usage, so a failed request costs nothing.",
  },
  {
    title: "The deployment is yours",
    image: "/images/wardrobe.webp",
    width: 620,
    height: 524,
    text: "Vercel and MongoDB with an external maintenance scheduler. No separate Redis account needed, and the source and operational notes are there to read.",
  },
];

const setupSteps = [
  {
    title: "Deploy the gateway",
    text: "Configure Vercel, MongoDB and your server secrets, then bootstrap the root account from a trusted machine.",
  },
  {
    title: "Connect your services",
    text: "Set up the maintenance scheduler, add a provider channel and list the models it can serve.",
  },
  {
    title: "Send a real request",
    text: "Fund a user's quota balance, issue a gateway key, then try it from your SDK or the playground.",
  },
];

const faqs = [
  {
    question: "Is this a model subscription?",
    answer:
      "No. This is gateway software you host. You bring your own provider accounts, and those services bill you for model usage and hosting. No model credits are included.",
  },
  {
    question: "Can I keep using my existing SDK?",
    answer:
      "For OpenAI-compatible requests, change your client's base URL and use a gateway-issued key. Anthropic Messages and Gemini endpoints are also available. Which features work depends on the provider, model and adapter you configure.",
  },
  {
    question: "Where do credentials live?",
    answer:
      "Provider credentials are encrypted before they reach the database. Gateway keys are stored as digests, and the full value appears only when you create or rotate one. Server secrets belong in your hosting environment, never in source or the client bundle.",
  },
  {
    question: "Do I need Redis?",
    answer:
      "No. MongoDB-only coordination covers shared limits, locks, queues and durable accounting; use Atlas or a transaction-capable replica set. Upstash Redis stays available as an optional backend, and the deployment docs cover the tradeoffs.",
  },
  {
    question: "What does the first request need?",
    answer:
      "Configure the server environment, bootstrap the root account from a trusted machine and connect the maintenance scheduler. Then add a provider channel, fund a user's quota balance and create a scoped gateway key. There is no public first-admin signup.",
  },
  {
    question: "Can I modify the source?",
    answer:
      "Yes, it is MIT licensed. Read the implementation, run your own deployment and change what you need. Check the license, the security notes and your providers' terms before you put it in production.",
  },
];

/** Decorative barcode; widths are fixed so server and client render alike. */
const bars = [
  3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3,
  1, 1, 2, 2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 1, 2, 1, 3, 1, 2, 1,
];
function Barcode({ className }: { className?: string }) {
  let x = 0;
  const rects = bars.map((width, index) => {
    const rect =
      index % 2 === 0 ? (
        <rect key={index} x={x} y="0" width={width} height="40" />
      ) : null;
    x += width;
    return rect;
  });
  return (
    <svg
      className={className}
      viewBox={`0 0 ${x} 40`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {rects}
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className={styles.site}>
      <a className="skip-link" href="#landing-content">
        Skip to content
      </a>
      <LandingNavigation />
      <main id="landing-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <span className={styles.heroRail} aria-hidden="true" />
          <div className={`${styles.shell} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.heroNote}>an AI gateway you host yourself</p>
              <h1 id="hero-title" className={styles.display}>
                one key in.
                <br />
                every model out.
              </h1>
              <p className={styles.lead}>
                Point an OpenAI, Anthropic or Gemini client at your own
                deployment, and it routes to the provider accounts you
                configured. Scoped keys, quotas and usage live in one calm
                console.
              </p>
              <div className={styles.heroActions}>
                <Link href="/console" className={styles.primaryButton}>
                  Open console
                  <ArrowRight size={18} />
                </Link>
                <a
                  href={repository}
                  target="_blank"
                  rel="noreferrer"
                  className={styles.ghostButton}
                >
                  Read the source
                </a>
              </div>
            </div>
            <div className={styles.heroArt}>
              <img
                className={styles.heroSweater}
                src="/images/sweater.webp"
                alt=""
                width={652}
                height={820}
                fetchPriority="high"
              />
              <div className={styles.heroTag}>
                <span className={styles.tagString} aria-hidden="true" />
                <span className={styles.tagHole} aria-hidden="true" />
                <p className={styles.heroTagTitle}>femboy api</p>
                <p className={styles.heroTagKicker}>self-hosted AI gateway</p>
                <dl className={styles.heroTagList}>
                  <div>
                    <dt>Speaks</dt>
                    <dd>OpenAI · Anthropic · Gemini</dd>
                  </div>
                  <div>
                    <dt>Runs on</dt>
                    <dd>Vercel + MongoDB</dd>
                  </div>
                  <div>
                    <dt>Credits</dt>
                    <dd>none included, bring your own</dd>
                  </div>
                  <div>
                    <dt>License</dt>
                    <dd>MIT</dd>
                  </div>
                </dl>
                <Barcode className={styles.barcode} />
              </div>
            </div>
          </div>
          <p className={styles.heroWordmark} aria-hidden="true">
            femboy
          </p>
        </section>

        <section
          id="routing"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="routing-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="routing-title" className={styles.title}>
              channels hang in priority order.
            </h2>
            <p className={styles.body}>
              The gateway walks the rail from the highest priority down and
              elects the first healthy channel, then spreads load by weight.
              Take a channel down and the next one picks the request up.
            </p>
          </div>
          <RouteDemo />
        </section>

        <section
          id="steps"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="steps-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="steps-title" className={styles.title}>
              every request takes the same four steps.
            </h2>
            <p className={styles.body}>
              The gateway decides before it spends anything. If a step fails
              the request stops there, and your provider account is never
              touched.
            </p>
          </div>
          <ol className={styles.labels}>
            {stages.map((stage, index) => (
              <li className={styles.label} key={stage.name}>
                <span className={styles.labelTop}>
                  <span className={styles.labelIcon} aria-hidden="true">
                    <stage.icon size={22} />
                  </span>
                  <span className={styles.labelIndex}>step {index + 1}</span>
                </span>
                <h3>{stage.name}</h3>
                <p>{stage.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={styles.providersBand}
          aria-labelledby="providers-title"
        >
          <div className={`${styles.shell} ${styles.providers}`}>
            <h2 id="providers-title" className={styles.title}>
              connect the accounts you already have.
            </h2>
            <div>
              <ul className={styles.providerList}>
                <li>OpenAI</li>
                <li>Anthropic</li>
                <li>Google Gemini</li>
                <li>OpenRouter</li>
                <li>and compatible APIs</li>
              </ul>
              <p className={styles.providerNote}>
                Independent software, not affiliated with any provider.
              </p>
            </div>
          </div>
        </section>

        <section
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="control-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="control-title" className={styles.title}>
              infrastructure, not another subscription.
            </h2>
            <p className={styles.body}>
              The gateway is a piece of your own stack. Provider accounts,
              access policy and the deployment itself stay with you.
            </p>
          </div>
          <div className={styles.ownership}>
            {ownership.map((item) => (
              <section className={styles.ownershipCard} key={item.title}>
                <div className={styles.ownershipArt}>
                  <img
                    src={item.image}
                    alt=""
                    width={item.width}
                    height={item.height}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </section>
            ))}
          </div>
        </section>

        <section
          id="integration"
          className={styles.integrationBand}
          aria-labelledby="integration-title"
        >
          <div className={`${styles.shell} ${styles.developerGrid}`}>
            <div className={styles.developerCopy}>
              <h2 id="integration-title" className={styles.title}>
                keep your SDK.
              </h2>
              <p className={styles.body}>
                Point an OpenAI client at your gateway, name a model you
                configured and pass a scoped key. The request format does not
                change.
              </p>
              <dl className={styles.alsoAvailable}>
                <dt>Also available</dt>
                <dd>Anthropic Messages</dd>
                <dd>Gemini content generation</dd>
                <dd>Streaming, where the model supports it</dd>
              </dl>
              <Link href="/console/docs" className={styles.quietLink}>
                Read the API reference
                <ArrowRight size={16} />
              </Link>
              <img
                className={styles.desk}
                src="/images/desk.webp"
                alt=""
                width={1100}
                height={331}
                loading="lazy"
                decoding="async"
              />
            </div>
            <LandingExamples />
          </div>
        </section>

        <section
          id="deploy"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="deploy-title"
        >
          <div className={styles.deployGrid}>
            <div>
              <h2 id="deploy-title" className={styles.title}>
                three steps to a first request.
              </h2>
              <p className={styles.body}>
                Start with the infrastructure, then connect the services that
                first request needs.
              </p>
              <Link href="/setup" className={styles.quietLink}>
                Open the deployment guide
                <ArrowRight size={16} />
              </Link>
              <img
                className={styles.yarn}
                src="/images/yarn.webp"
                alt=""
                width={517}
                height={560}
                loading="lazy"
                decoding="async"
              />
            </div>
            <ol className={styles.setupSteps}>
              {setupSteps.map((step, index) => (
                <li key={step.title}>
                  <span className={styles.stepButton} aria-hidden="true">
                    {index + 1}
                  </span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="questions"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="faq-title"
        >
          <div className={styles.faqGrid}>
            <div className={styles.faqIntro}>
              <h2 id="faq-title" className={styles.title}>
                before you deploy.
              </h2>
              <img
                className={styles.faqHanger}
                src="/images/hanger.webp"
                alt=""
                width={480}
                height={398}
                loading="lazy"
                decoding="async"
              />
            </div>
            <div className={styles.faqList}>
              {faqs.map((item) => (
                <details key={item.question}>
                  <summary>
                    {item.question}
                    <ChevronDown size={20} />
                  </summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <span className={styles.heroRail} aria-hidden="true" />
          <div className={`${styles.shell} ${styles.closingInner}`}>
            <h2 id="closing-title" className={styles.display}>
              make it your gateway.
            </h2>
            <div className={styles.heroActions}>
              <Link href="/console" className={styles.primaryButton}>
                Open console
                <ArrowRight size={18} />
              </Link>
              <Link href="/setup" className={styles.ghostButton}>
                Deployment guide
              </Link>
            </div>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={`${styles.shell} ${styles.footerInner}`}>
          <div className={styles.footerBrand}>
            <LandingWordmark />
            <p>An independent gateway for your provider accounts.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href={repository} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <Link href="/setup">Deployment</Link>
            <a
              href={`${repository}/blob/main/docs/SECURITY.md`}
              target="_blank"
              rel="noreferrer"
            >
              Security notes
            </a>
            <a
              href={`${repository}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer"
            >
              MIT license
            </a>
          </nav>
          <div className={styles.footerNote}>
            <p>
              Bring your own accounts, and review your providers' terms before
              production use.
            </p>
            <Barcode className={styles.footerBarcode} />
          </div>
        </div>
      </footer>
    </div>
  );
}
