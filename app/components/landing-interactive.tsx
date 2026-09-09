"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Menu, ShieldCheck } from "lucide-react";
import { CopyButton, Dialog, ThemePicker } from "./interface.tsx";
import { landingExamples } from "../../lib/landing/examples.ts";
import styles from "../landing.module.css";

const repository = "https://github.com/overwrite249-art/femboy-api";
const navigation = [
  ["Product", "/#platform"],
  ["Developers", "/#developers"],
  ["Deployment", "/setup"],
] as const;

export function LandingWordmark() {
  return (
    <span className={styles.wordmark}>
      <span className={styles.monogram} aria-hidden="true">
        f/
      </span>
      <span>
        femboy<span className={styles.wordmarkSuffix}> / api</span>
      </span>
    </span>
  );
}

export function LandingNavigation() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  return (
    <>
      <header className={styles.header}>
        <div className={`${styles.shell} ${styles.headerInner}`}>
          <Link
            href="/"
            aria-label="Femboy API home"
            className={styles.homeLink}
          >
            <LandingWordmark />
          </Link>
          <nav
            className={styles.desktopNavigation}
            aria-label="Landing page navigation"
          >
            {navigation.map(([label, href]) => (
              <a href={href} key={label}>
                {label}
              </a>
            ))}
          </nav>
          <div className={styles.navTools}>
            <div className={styles.desktopTheme}>
              <ThemePicker />
            </div>
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
              className={styles.menuToggle}
              type="button"
              aria-label="Open site menu"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen(true)}
            >
              <Menu size={21} />
            </button>
          </div>
        </div>
      </header>
      <Dialog
        open={open}
        title="Site navigation"
        onClose={() => setOpen(false)}
        className={styles.navDialog}
      >
        <nav
          id={menuId}
          className={styles.mobileNavigation}
          aria-label="Mobile landing page navigation"
        >
          {navigation.map(([label, href]) => (
            <a href={href} key={label} onClick={() => setOpen(false)}>
              {label}
              <ArrowRight size={17} />
            </a>
          ))}
          <a href="/#questions" onClick={() => setOpen(false)}>
            Questions
            <ArrowRight size={17} />
          </a>
          <Link href="/login" onClick={() => setOpen(false)}>
            Sign in
            <ArrowUpRight size={17} />
          </Link>
          <a
            href={repository}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            GitHub
            <ArrowUpRight size={17} />
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

const views = [
  {
    name: "Routing",
    href: "/console/channels",
    action: "Manage channels",
    label: "PROVIDER CHANNELS",
    heading: "Priority first. Weight next.",
    note: "Routing uses channels configured for the requested model and group.",
    aside: "BEFORE THE PROVIDER CALL",
    steps: [
      ["Scope", "Check key, model and IP access."],
      ["Quota", "Reserve against available balance."],
      ["Route", "Apply health, priority and weight."],
      ["Forward", "Use the configured provider channel."],
    ],
  },
  {
    name: "Access",
    href: "/console/tokens",
    action: "Manage gateway keys",
    label: "APPLICATION ACCESS",
    heading: "A separate key for each application.",
    note: "Your application key is not your provider credential.",
    aside: "A DELIBERATE KEY LIFECYCLE",
    steps: [
      ["Create", "Choose an owner and access policy."],
      ["Store", "Keep the full key privately on your server."],
      ["Rotate", "Replace or revoke when access changes."],
    ],
  },
  {
    name: "Usage",
    href: "/console/usage",
    action: "Inspect usage",
    label: "REQUEST RECORDS",
    heading: "Useful metadata. No prompt archive.",
    note: "Recorded usage appears after real requests are processed and rolled up.",
    aside: "ACCOUNTING ORDER",
    steps: [
      ["Reserve", "Check the owner balance and key quota."],
      ["Request", "Send to a configured upstream channel."],
      ["Settle", "Account for the recorded usage."],
    ],
  },
] as const;

export function ProductTour() {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const view = views[active];
  return (
    <div className={styles.workbench}>
      <div className={styles.workbenchBar}>
        <div
          className={styles.workbenchTabs}
          role="tablist"
          aria-label="Explore gateway capabilities"
        >
          {views.map((item, index) => (
            <button
              key={item.name}
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
                moveTab(event, index, views.length, setActive, tabs.current)
              }
            >
              {item.name}
            </button>
          ))}
        </div>
        <span className={styles.exampleLabel}>EXAMPLE / READ ONLY</span>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        tabIndex={0}
        className={styles.workbenchPanel}
      >
        <div className={styles.workspacePreview}>
          <p className={styles.marginLabel}>{view.label}</p>
          <h3>{view.heading}</h3>
          {active === 0 ? (
            <div className={styles.routingTable}>
              <table>
                <caption className="sr-only">
                  Illustrative provider channel priorities and weights
                </caption>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Priority</th>
                    <th>Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["OpenAI", "openai-primary", "100", "10"],
                    ["Anthropic", "anthropic-primary", "90", "10"],
                    ["Google Gemini", "gemini-primary", "80", "10"],
                  ].map(([name, slug, priority, weight]) => (
                    <tr key={slug}>
                      <td>
                        <strong>{name}</strong>
                        <span>{slug}</span>
                      </td>
                      <td>{priority}</td>
                      <td>{weight}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : active === 1 ? (
            <dl className={styles.policyRows}>
              <div>
                <dt>Model scope</dt>
                <dd>Named models or a prefix rule</dd>
              </div>
              <div>
                <dt>Expiration</dt>
                <dd>Optional timestamp</dd>
              </div>
              <div>
                <dt>IP scope</dt>
                <dd>Addresses or CIDR ranges</dd>
              </div>
              <div>
                <dt>Quota</dt>
                <dd>Key limit + owner balance</dd>
              </div>
              <div>
                <dt>Stored token</dt>
                <dd>One-way digest</dd>
              </div>
            </dl>
          ) : (
            <div className={styles.usagePreview}>
              <div className={styles.usageSchema}>
                <span>RECORDED</span>
                <p>
                  Model · outcome · latency
                  <br />
                  Token counts · quota
                </p>
              </div>
              <div className={styles.usageSchema}>
                <span>NOT IN USAGE LOGS</span>
                <p>Prompt and completion content</p>
              </div>
              <p className={styles.noSample}>
                No sample traffic is added to your workspace.
              </p>
            </div>
          )}
          <p className={styles.previewNote}>{view.note}</p>
        </div>
        <aside className={styles.requestPath}>
          <p className={styles.marginLabel}>{view.aside}</p>
          <ol>
            {view.steps.map(([title, text], index) => (
              <li key={title}>
                <span className={styles.pathNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h4>{title}</h4>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <div className={styles.workbenchFooter}>
        <span>
          <ShieldCheck size={16} /> No credentials needed. Nothing is sent.
        </span>
        <Link href={view.href}>
          {view.action}
          <ArrowUpRight size={16} />
        </Link>
      </div>
    </div>
  );
}

const languages = ["JavaScript", "Python", "cURL"] as const;
function HighlightedCode({ source }: { source: string }) {
  const parts = source.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|const|await|new)\b)/g,
  );
  return (
    <code>
      {parts.map((part, index) =>
        /^("|')/.test(part) ? (
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
    <div className={styles.codePanel}>
      <div className={styles.codeToolbar}>
        <div
          role="tablist"
          aria-label="Request example language"
          className={styles.codeTabs}
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
        className={styles.exampleCode}
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${active}`}
        aria-describedby={`${id}-note`}
        tabIndex={0}
      >
        <HighlightedCode source={examples[language]} />
      </pre>
      <p className={styles.codeScrollHint}>
        Scroll horizontally to view the full example.
      </p>
      <p className={styles.codeNote} id={`${id}-note`}>
        Set <code>FEMBOY_API_KEY</code> in your server environment. Replace{" "}
        <code>YOUR_MODEL</code> with a configured model. This page does not send
        requests.
      </p>
    </div>
  );
}
