import Link from "next/link";
import { ChevronDown } from "lucide-react";
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
    text: "Check the gateway key: is the model allowed, is the key still live, is the caller's address in range.",
  },
  {
    name: "Reserve",
    text: "Hold quota against the owner's balance before anything leaves your deployment.",
  },
  {
    name: "Route",
    text: "Elect a healthy channel by priority, then by weight, and translate the request into that provider's dialect.",
  },
  {
    name: "Settle",
    text: "Record what the call used and settle the hold. Request metadata is kept; prompts are not archived.",
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

export default function LandingPage() {
  return (
    <div className={styles.site}>
      <a className="skip-link" href="#landing-content">
        Skip to content
      </a>
      <LandingNavigation />
      <main id="landing-content" tabIndex={-1}>
        <section
          className={`${styles.shell} ${styles.hero}`}
          aria-labelledby="hero-title"
        >
          <div className={styles.heroCopy}>
            <h1 id="hero-title" className={styles.display}>
              One key in.
              <br />
              Every model out.
            </h1>
            <p className={styles.lead}>
              A self-hosted AI gateway. Point an OpenAI, Anthropic or Gemini
              client at your own deployment, and it routes to the provider
              accounts you configured.
            </p>
            <div className={styles.heroActions}>
              <Link href="/console" className={styles.primaryButton}>
                Open console
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
            <p className={styles.heroFacts}>
              <span>
                Runs on <b>Vercel</b> and <b>MongoDB</b>
              </span>
              <span>
                <b>MIT</b> licensed
              </span>
              <span>no model credits included</span>
            </p>
          </div>
          <RouteDemo />
        </section>

        <section
          id="routing"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="routing-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="routing-title" className={styles.title}>
              Every request takes the same four steps.
            </h2>
            <div className={styles.sectionAside}>
              <p className={styles.body}>
                The gateway decides before it spends anything. If a step fails
                the request stops there, and your provider account is never
                touched.
              </p>
            </div>
          </div>
          <ol className={styles.pipeline}>
            {stages.map((stage, index) => (
              <li className={styles.stage} key={stage.name}>
                <span className={styles.stageIndex}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{stage.name}</h3>
                <p>{stage.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={`${styles.shell} ${styles.providers}`}
          aria-labelledby="providers-title"
        >
          <h2 id="providers-title" className={styles.title}>
            Connect the accounts you already have.
          </h2>
          <div>
            <ul className={styles.providerList}>
              <li>OpenAI</li>
              <li>Anthropic</li>
              <li>Google Gemini</li>
              <li>OpenRouter</li>
              <li>and compatible APIs</li>
            </ul>
            <p className={`${styles.tag}`} style={{ marginTop: "18px" }}>
              independent software, not affiliated with any provider
            </p>
          </div>
        </section>

        <section
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="control-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="control-title" className={styles.title}>
              Infrastructure, not another subscription.
            </h2>
            <div className={styles.sectionAside}>
              <p className={styles.body}>
                The gateway is a piece of your own stack. Provider accounts,
                access policy and the deployment itself stay with you.
              </p>
            </div>
          </div>
          <div className={styles.ownership}>
            <section>
              <h3>Keys stay separated</h3>
              <p>
                Provider credentials are encrypted before storage. Applications
                get their own gateway keys, scoped by model, expiry and
                address, so no app ever holds your upstream credential.
              </p>
            </section>
            <section>
              <h3>Spending is reserved, then settled</h3>
              <p>
                Every user has a balance and every key can carry its own limit.
                Quota is held before the call and settled against recorded
                usage, so a failed request costs nothing.
              </p>
            </section>
            <section>
              <h3>The deployment is yours</h3>
              <p>
                Vercel and MongoDB with an external maintenance scheduler. No
                separate Redis account needed, and the source and operational
                notes are there to read.
              </p>
            </section>
          </div>
        </section>

        <section
          id="integration"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="integration-title"
        >
          <div className={styles.developerGrid}>
            <div className={styles.developerCopy}>
              <h2 id="integration-title" className={styles.title}>
                Keep your SDK.
              </h2>
              <p className={styles.body}>
                Point an OpenAI client at your gateway, name a model you
                configured and pass a scoped key. The request format does not
                change.
              </p>
              <Link href="/console/docs" className={styles.quietLink}>
                Read the API reference
              </Link>
              <dl className={styles.alsoAvailable}>
                <dt>Also available</dt>
                <dd>Anthropic Messages</dd>
                <dd>Gemini content generation</dd>
                <dd>Streaming, where the model supports it</dd>
              </dl>
            </div>
            <LandingExamples />
          </div>
        </section>

        <section
          id="deploy"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="deploy-title"
        >
          <div className={styles.sectionHead}>
            <h2 id="deploy-title" className={styles.title}>
              Three steps to a first request.
            </h2>
            <div className={styles.sectionAside}>
              <p className={styles.body}>
                Start with the infrastructure, then connect the services that
                first request needs.
              </p>
              <Link href="/setup" className={styles.quietLink}>
                Open the deployment guide
              </Link>
            </div>
          </div>
          <ol className={styles.setupSteps}>
            <li>
              <div>
                <h3>Deploy the gateway</h3>
                <p>
                  Configure Vercel, MongoDB and your server secrets, then
                  bootstrap the root account from a trusted machine.
                </p>
              </div>
            </li>
            <li>
              <div>
                <h3>Connect your services</h3>
                <p>
                  Set up the maintenance scheduler, add a provider channel and
                  list the models it can serve.
                </p>
              </div>
            </li>
            <li>
              <div>
                <h3>Send a real request</h3>
                <p>
                  Fund a user's quota balance, issue a gateway key, then try it
                  from your SDK or the playground.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section
          id="questions"
          className={`${styles.shell} ${styles.section}`}
          aria-labelledby="faq-title"
        >
          <div className={styles.faqGrid}>
            <h2 id="faq-title" className={styles.title}>
              Before you deploy.
            </h2>
            <div className={styles.faqList}>
              {faqs.map((item) => (
                <details key={item.question}>
                  <summary>
                    {item.question}
                    <ChevronDown size={18} />
                  </summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <div className={`${styles.shell} ${styles.closingInner}`}>
            <h2 id="closing-title" className={styles.display}>
              Make it your gateway.
            </h2>
            <Link href="/console" className={styles.primaryButton}>
              Open console
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
        <p className={styles.footerNote}>
          Bring your own accounts, and review your providers' terms before
          production use.
        </p>
      </footer>
    </div>
  );
}
