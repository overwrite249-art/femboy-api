"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
import { ChevronDown, Menu } from "lucide-react";
import { CopyButton, Dialog, ThemePicker } from "./interface.tsx";
import { landingExamples } from "../../lib/landing/examples.ts";
import styles from "../landing.module.css";

const repository = "https://github.com/overwrite249-art/femboy-api";
const navigation = [
  ["Routing", "/#routing"],
  ["Integration", "/#integration"],
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
          <a href="/#questions" onClick={() => setOpen(false)}>
            Questions
          </a>
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
        <div className={styles.mobileTheme}>
          <span>Appearance</span>
          <ThemePicker />
        </div>
      </Dialog>
    </>
  );
}

/**
 * Routing example.
 *
 * Channels are ordered by priority, the way the gateway evaluates them. Take
 * one down and the election moves to the next healthy channel; take them all
 * down and the request fails fast. Nothing here talks to a server.
 */
const channels = [
  { provider: "OpenAI", id: "openai-primary", priority: 100, weight: 10 },
  { provider: "Anthropic", id: "anthropic-primary", priority: 90, weight: 10 },
  { provider: "Google Gemini", id: "gemini-primary", priority: 80, weight: 10 },
  { provider: "OpenRouter", id: "openrouter-pool", priority: 70, weight: 5 },
] as const;

export function RouteDemo() {
  const [down, setDown] = useState<boolean[]>(() => channels.map(() => false));
  const [run, setRun] = useState(0);
  const [drop, setDrop] = useState(40);
  const bridge = useRef<HTMLDivElement | null>(null);
  const joints = useRef<Array<HTMLSpanElement | null>>([]);

  const elected = down.findIndex((isDown) => !isDown);
  const anyDown = down.some(Boolean);

  useEffect(() => {
    const start = bridge.current;
    const joint = elected >= 0 ? joints.current[elected] : null;
    if (!start || !joint) return;
    const from = start.getBoundingClientRect();
    const to = joint.getBoundingClientRect();
    setDrop(Math.max(16, Math.round(to.top + 28 - from.top)));
    setRun((value) => value + 1);
  }, [elected]);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h2>Routing example</h2>
        <span className={styles.tag}>click a channel to take it down</span>
      </div>
      <div className={styles.panelBody}>
        <p className={styles.request}>
          <b>POST</b> /v1/chat/completions
        </p>
        <div className={styles.bridge} ref={bridge}>
          {run > 0 && elected >= 0 ? (
            <span
              key={run}
              className={styles.pulse}
              style={{ "--drop": `${drop}px` } as React.CSSProperties}
              aria-hidden="true"
            />
          ) : null}
        </div>
        <ul className={styles.channels}>
          {channels.map((channel, index) => {
            const isDown = down[index];
            const isElected = index === elected;
            return (
              <li
                key={channel.id}
                className={styles.channel}
                data-state={isDown ? "down" : "up"}
                data-elected={isElected ? "true" : "false"}
                data-reached={elected >= 0 && index <= elected ? "true" : "false"}
              >
                <span
                  className={styles.conn}
                  aria-hidden="true"
                  ref={(element) => {
                    joints.current[index] = element;
                  }}
                />
                <button
                  type="button"
                  className={styles.channelButton}
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
                  <span className={styles.channelName}>
                    <strong>{channel.provider}</strong>
                    <span>{channel.id}</span>
                  </span>
                  <span className={styles.channelMeta}>
                    priority {channel.priority}
                  </span>
                  <span className={styles.channelMeta}>
                    weight {channel.weight}
                  </span>
                  <span className={styles.channelState}>
                    {isDown ? "down" : "healthy"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p
        className={`${styles.verdict} ${elected < 0 ? styles.verdictDown : ""}`}
        aria-live="polite"
      >
        {elected >= 0 ? (
          <span>
            Elected <b>{channels[elected].id}</b> at priority{" "}
            {channels[elected].priority}.
          </span>
        ) : (
          <span>
            <b>No healthy channel.</b> The request fails with 503 and no quota
            is spent.
          </span>
        )}
        {anyDown ? (
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => setDown(channels.map(() => false))}
          >
            bring all back up
          </button>
        ) : null}
      </p>
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
