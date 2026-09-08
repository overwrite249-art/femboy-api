"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Code2,
  KeyRound,
  Layers3,
  LockKeyhole,
  Menu,
  Route,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Brand, CopyButton, Dialog, ThemePicker } from "./interface.tsx";
import { landingExamples } from "../../lib/landing/examples.ts";
import styles from "../landing.module.css";

const navigation = [
  ["Platform", "/#platform"],
  ["Developers", "/#developers"],
  ["Get started", "/#get-started"],
  ["Questions", "/#questions"],
] as const;

export function LandingNavigation() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <>
      <header className={styles.navigation}>
        <Link href="/" className={styles.navBrand} aria-label="femboy api home">
          <Brand />
        </Link>
        <nav
          className={styles.desktopNavigation}
          aria-label="Landing page navigation"
        >
          {navigation.slice(0, 3).map(([label, href]) => (
            <a key={label} href={href}>
              {label}
            </a>
          ))}
        </nav>
        <div className={styles.navTools}>
          <div className={styles.desktopTheme}>
            <ThemePicker />
          </div>
          <Link className={styles.signIn} href="/login">
            Sign in
          </Link>
          <Link
            href="/console"
            className={styles.navConsole}
            aria-label="Open console"
          >
            <span>
              <span className={styles.navOpenWord}>Open </span>console
            </span>
            <ArrowUpRight size={16} />
          </Link>
          <button
            type="button"
            className={styles.menuToggle}
            aria-label="Open site navigation"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen(true)}
          >
            <Menu size={21} />
          </button>
        </div>
      </header>
      <Dialog
        open={open}
        title="Explore femboy api"
        onClose={() => setOpen(false)}
        className={styles.mobileDialog}
      >
        <nav
          id={menuId}
          className={styles.mobileNavigation}
          aria-label="Mobile landing page navigation"
        >
          {navigation.map(([label, href]) => (
            <a key={label} href={href} onClick={() => setOpen(false)}>
              {label}
              <ArrowRight size={17} />
            </a>
          ))}
          <Link href="/login" onClick={() => setOpen(false)}>
            Sign in <ArrowUpRight size={17} />
          </Link>
          <a
            href="https://github.com/overwrite249-art/femboy-api"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            View GitHub <Code2 size={17} />
          </a>
        </nav>
        <div className={styles.mobileTheme}>
          <span>Appearance</span>
          <ThemePicker />
        </div>
      </Dialog>
    </>
  );
}

const tour = [
  {
    id: "routing",
    title: "Route your way.",
    description:
      "Connect providers. Set priorities and weights. Let health-aware routing choose a configured channel.",
    label: "Provider routing",
    icon: Route,
    href: "/console/channels",
    action: "Explore channels",
  },
  {
    id: "access",
    title: "Give access. Keep control.",
    description:
      "Issue scoped gateway keys without sharing your upstream credentials. Rotate, limit or revoke them deliberately.",
    label: "Scoped access",
    icon: KeyRound,
    href: "/console/tokens",
    action: "Explore API keys",
  },
  {
    id: "usage",
    title: "See the request, not the guesswork.",
    description:
      "Inspect usage metadata, quotas and outcomes. Export the records you need without storing prompt content in usage logs.",
    label: "Usage visibility",
    icon: Activity,
    href: "/console/usage",
    action: "Explore usage",
  },
] as const;

function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  choose: (index: number) => void,
  refs: Array<HTMLButtonElement | null>,
) {
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown")
    next = (index + 1) % count;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
    next = (index + count - 1) % count;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = count - 1;
  else return;
  event.preventDefault();
  choose(next);
  refs[next]?.focus();
}

export function ProductTour() {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = tour[active];
  return (
    <div className={styles.tourLayout}>
      <div>
        <div
          className={styles.tourTabs}
          role="tablist"
          aria-label="Explore gateway capabilities"
          aria-orientation="vertical"
        >
          {tour.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                id={`${id}-tab-${index}`}
                role="tab"
                aria-selected={active === index}
                aria-controls={`${id}-panel`}
                tabIndex={active === index ? 0 : -1}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                className={`${styles.tourTab} ${active === index ? styles.tourTabActive : ""}`}
                onClick={() => setActive(index)}
                onKeyDown={(event) =>
                  moveTab(event, index, tour.length, setActive, tabs.current)
                }
              >
                <span className={styles.tourNumber}>0{index + 1}</span>
                <span>
                  <strong>{item.title}</strong>
                  <span className={styles.tourDescription}>
                    {item.description}
                  </span>
                </span>
                <Icon size={20} className={styles.tourTabIcon} />
              </button>
            );
          })}
        </div>
        <p className={styles.tourDisclosure}>
          <Code2 size={16} /> Interactive product tour. No requests are sent.
        </p>
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${active}`}
        tabIndex={0}
        className={styles.tourPanel}
      >
        <div className={styles.previewBar}>
          <span>
            <Layers3 size={18} />
            <strong>femboy / api</strong>
            <ChevronRight size={14} />
            {selected.label}
          </span>
          <span className={styles.previewBadge}>Product preview</span>
        </div>
        <div className={styles.previewContent}>
          {active === 0 ? (
            <>
              <div className={styles.previewHeading}>
                <div>
                  <span>PROVIDER CONNECTIONS</span>
                  <h3>Your stack, connected.</h3>
                </div>
                <Route size={25} />
              </div>
              <div
                className={styles.routingDiagram}
                aria-label="Application to gateway to provider routing"
              >
                <div className={styles.routeSource}>
                  <Code2 size={24} />
                  <span>Your application</span>
                </div>
                <div className={styles.routeLine} aria-hidden="true">
                  <span />
                  <ArrowRight size={17} />
                </div>
                <div className={styles.routeHub}>
                  <Layers3 size={31} />
                  <strong>One gateway</strong>
                </div>
                <div className={styles.routeLine} aria-hidden="true">
                  <span />
                  <ArrowRight size={17} />
                </div>
                <div className={styles.routeTargets}>
                  <span>
                    <span className={styles.providerDot} />
                    OpenAI
                  </span>
                  <span>
                    <span className={styles.providerDot} />
                    Anthropic
                  </span>
                  <span>
                    <span className={styles.providerDot} />
                    Gemini
                  </span>
                </div>
              </div>
              <div className={styles.previewSettings}>
                <div>
                  <span>Channel selection</span>
                  <strong>Priority + weight</strong>
                </div>
                <div>
                  <span>Provider credentials</span>
                  <strong>
                    <LockKeyhole size={14} /> Encrypted at rest
                  </strong>
                </div>
              </div>
              <p className={styles.previewHint}>
                Illustrative configuration. Bring your own provider accounts.
              </p>
            </>
          ) : active === 1 ? (
            <>
              <div className={styles.previewHeading}>
                <div>
                  <span>APPLICATION ACCESS</span>
                  <h3>A key for each idea.</h3>
                </div>
                <KeyRound size={25} />
              </div>
              <div className={styles.scopeCard}>
                <div className={styles.scopeTop}>
                  <span className={styles.scopeIcon}>
                    <KeyRound size={22} />
                  </span>
                  <div>
                    <strong>Your application key</strong>
                    <span>Example access policy</span>
                  </div>
                  <ShieldCheck size={21} />
                </div>
                <div className={styles.scopeRow}>
                  <span>Model access</span>
                  <strong>Only configured models</strong>
                </div>
                <div className={styles.scopeRow}>
                  <span>Expiration</span>
                  <strong>Set by you</strong>
                </div>
                <div className={styles.scopeRow}>
                  <span>IP restrictions</span>
                  <strong>Your allowed addresses</strong>
                </div>
                <div className={styles.scopeRow}>
                  <span>Secret storage</span>
                  <strong>Digest only</strong>
                </div>
              </div>
              <p className={styles.previewHint}>
                <ShieldCheck size={15} /> Gateway keys and provider credentials
                stay separate.
              </p>
            </>
          ) : (
            <>
              <div className={styles.previewHeading}>
                <div>
                  <span>USAGE &amp; LOGS</span>
                  <h3>A clearer view of your AI.</h3>
                </div>
                <Activity size={25} />
              </div>
              <div className={styles.usageFields}>
                <span>Model</span>
                <span>Tokens</span>
                <span>Quota</span>
                <span>Outcome</span>
              </div>
              <div className={styles.usagePreview}>
                <Activity size={34} />
                <strong>Real requests. Useful details.</strong>
                <p>
                  Recorded activity appears after you send requests. No sample
                  traffic is added to your workspace.
                </p>
              </div>
              <div className={styles.previewTags}>
                <span>
                  <Check size={14} /> Request metadata
                </span>
                <span>
                  <Check size={14} /> Filtered CSV exports
                </span>
              </div>
            </>
          )}
        </div>
        <div className={styles.previewFooter}>
          <span>Designed for your infrastructure.</span>
          <Link href={selected.href}>
            {selected.action}
            <ArrowUpRight size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
}

type Language = "JavaScript" | "Python" | "cURL";
const languages: Language[] = ["JavaScript", "Python", "cURL"];

function HighlightedCode({ source }: { source: string }) {
  const parts = source.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|const|await|new)\b)/g,
  );
  return (
    <code>
      {parts.map((part, index) =>
        /^(["'])/.test(part) ? (
          <span className={styles.codeString} key={index}>
            {part}
          </span>
        ) : /^(import|from|const|await|new)$/.test(part) ? (
          <span className={styles.codeKeyword} key={index}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </code>
  );
}

export function LandingExamples() {
  const [origin, setOrigin] = useState("https://your-gateway.example");
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setOrigin(window.location.origin), []);
  const examples = landingExamples(origin);
  const language = languages[active];
  return (
    <div className={styles.exampleWindow}>
      <div className={styles.exampleTitle}>
        <span>
          <Terminal size={16} /> YOUR NEXT INTEGRATION
        </span>
        <span>Example request</span>
      </div>
      <div className={styles.exampleToolbar}>
        <div
          className={styles.exampleTabs}
          role="tablist"
          aria-label="Request example language"
        >
          {languages.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={active === index}
              aria-controls={`${id}-panel`}
              tabIndex={active === index ? 0 : -1}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              onClick={() => setActive(index)}
              onKeyDown={(event) =>
                moveTab(event, index, languages.length, setActive, tabs.current)
              }
              className={active === index ? styles.exampleTabActive : ""}
            >
              {name}
            </button>
          ))}
        </div>
        <CopyButton
          value={examples[language]}
          label="Copy request example"
          iconOnly
        />
      </div>
      <pre
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${active}`}
        tabIndex={0}
        className={styles.exampleCode}
      >
        <HighlightedCode source={examples[language]} />
      </pre>
      <div className={styles.exampleFoot}>
        <ShieldCheck size={16} />
        <span>
          Set <code>FEMBOY_API_KEY</code> privately in your environment. Replace{" "}
          <code>YOUR_MODEL</code> with a configured model. Nothing runs on this
          page.
        </span>
      </div>
    </div>
  );
}
