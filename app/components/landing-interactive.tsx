"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import Link from "next/link";
import { Menu, RotateCcw } from "lucide-react";
import { CopyButton, Dialog, HangerMark } from "./interface.tsx";
import { landingExamples } from "../../lib/landing/examples.ts";
import styles from "../landing.module.css";

const repository = "https://github.com/overwrite249-art/femboy-api";
const navigation = [
  ["Routing", "/#routing"],
  ["Integration", "/#integration"],
  ["Deployment", "/setup"],
  ["Questions", "/#questions"],
] as const;

export function LandingWordmark() {
  return (
    <span className={styles.wordmark}>
      <span className={styles.wordmarkMark} aria-hidden="true">
        <HangerMark size={22} />
      </span>
      <span>
        femboy<span className={styles.wordmarkSuffix}> api</span>
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
            <Link href="/login" className={styles.navSignIn}>
              Sign in
            </Link>
            <Link
              href="/console"
              className={styles.navConsole}
              aria-label="Open console"
            >
              <span className={styles.navOpenWord}>Open&nbsp;</span>console
            </Link>
            <button
              className={styles.menuToggle}
              type="button"
              aria-label="Open site menu"
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen(true)}
            >
              <Menu size={20} />
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
            </a>
          ))}
          <Link href="/login" onClick={() => setOpen(false)}>
            Sign in
          </Link>
          <a
            href={repository}
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
          >
            Source on GitHub
          </a>
        </nav>
      </Dialog>
    </>
  );
}

/**
 * Routing example.
 *
 * Channels hang on the rail in priority order, the way the gateway evaluates
 * them. Take one down and the election moves to the next healthy channel;
 * take them all down and the request fails fast. Nothing here talks to a
 * server.
 */
const channels = [
  {
    provider: "OpenAI",
    id: "openai-primary",
    priority: 100,
    weight: 10,
    garment: "/images/garment-1.webp",
  },
  {
    provider: "Anthropic",
    id: "anthropic-primary",
    priority: 90,
    weight: 10,
    garment: "/images/garment-2.webp",
  },
  {
    provider: "Google Gemini",
    id: "gemini-primary",
    priority: 80,
    weight: 10,
    garment: "/images/garment-3.webp",
  },
  {
    provider: "OpenRouter",
    id: "openrouter-pool",
    priority: 70,
    weight: 5,
    garment: "/images/garment-4.webp",
  },
] as const;

export function RouteDemo() {
  const [down, setDown] = useState<boolean[]>(() => channels.map(() => false));
  const [travel, setTravel] = useState<number | null>(null);
  const rail = useRef<HTMLDivElement | null>(null);
  const hooks = useRef<Array<HTMLSpanElement | null>>([]);

  const elected = down.findIndex((isDown) => !isDown);
  const anyDown = down.some(Boolean);

  useEffect(() => {
    function measure() {
      const start = rail.current;
      const hook = elected >= 0 ? hooks.current[elected] : null;
      if (!start || !hook) {
        setTravel(null);
        return;
      }
      const from = start.getBoundingClientRect();
      const to = hook.getBoundingClientRect();
      setTravel(Math.round(to.left + to.width / 2 - from.left));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [elected]);

  return (
    <div className={styles.rack}>
      <div className={styles.rackHead}>
        <p className={styles.request}>
          <b>POST</b> /v1/chat/completions
        </p>
        <p className={styles.rackHint}>
          <svg
            viewBox="0 0 60 34"
            width="54"
            height="30"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M4 6c14 0 30 6 40 22m0 0-1-9m1 9-9-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          tap a garment to take its channel down
        </p>
      </div>
      <div className={styles.rail} ref={rail}>
        <span className={styles.railBar} aria-hidden="true" />
        <span
          className={styles.courier}
          data-visible={travel !== null ? "true" : "false"}
          style={{ "--travel": `${travel ?? 0}px` } as CSSProperties}
          aria-hidden="true"
        />
        <ul className={styles.hangers}>
          {channels.map((channel, index) => {
            const isDown = down[index];
            const isElected = index === elected;
            return (
              <li
                key={channel.id}
                className={styles.hanger}
                data-state={isDown ? "down" : "up"}
                data-elected={isElected ? "true" : "false"}
              >
                <span
                  className={styles.hook}
                  aria-hidden="true"
                  ref={(element) => {
                    hooks.current[index] = element;
                  }}
                />
                <button
                  type="button"
                  className={styles.garmentButton}
                  aria-pressed={isDown}
                  aria-label={
                    isDown
                      ? `Bring ${channel.provider} back up`
                      : `Take ${channel.provider} down`
                  }
                  onClick={() =>
                    setDown((current) =>
                      current.map((value, position) =>
                        position === index ? !value : value,
                      ),
                    )
                  }
                >
                  <img
                    className={styles.garment}
                    src={channel.garment}
                    alt=""
                    width={293}
                    height={360}
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                <div className={styles.tag}>
                  <span className={styles.tagHole} aria-hidden="true" />
                  <strong>{channel.provider}</strong>
                  <code>{channel.id}</code>
                  <span className={styles.tagMeta}>
                    priority {channel.priority} · weight {channel.weight}
                  </span>
                  <span className={styles.tagState}>
                    {isDown ? "down" : isElected ? "elected" : "healthy"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div
        className={`${styles.verdict} ${elected < 0 ? styles.verdictDown : ""}`}
      >
        <p aria-live="polite">
          {elected >= 0 ? (
            <>
              Elected <b>{channels[elected].id}</b> at priority{" "}
              {channels[elected].priority}.
            </>
          ) : (
            <>
              <b>No healthy channel.</b> The request fails with 503 and no
              quota is spent.
            </>
          )}
        </p>
        {anyDown ? (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => setDown(channels.map(() => false))}
          >
            <RotateCcw size={16} />
            Bring all back up
          </button>
        ) : null}
      </div>
    </div>
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
        <span className={styles.codeDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
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
      <p className={styles.codeNote} id={`${id}-note`}>
        Set <code>FEMBOY_API_KEY</code> in your server environment and replace{" "}
        <code>YOUR_MODEL</code> with a model you configured. This page sends no
        requests.
      </p>
    </div>
  );
}
