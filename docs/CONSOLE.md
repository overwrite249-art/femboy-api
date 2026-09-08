# Console guide

The console is available at `/console`. It uses a cookie session; gateway API keys do not grant console access.

## Workspace

- **Overview:** monthly recorded usage, real channel/key/user counts, connection details, launch checklist, and copyable SDK examples. Empty states do not fabricate traffic.
- **Playground:** an explicitly confirmed, non-streaming chat request with model, prompt, optional system instructions, temperature, and output-token controls. Inspect text or JSON, copy a request template, stop waiting, or reset and clear the entered key.
- **Channels:** search/filter the current page, use provider presets, manage keys, enable/disable routing, and run deliberate provider probes. Probes may consume provider quota.
- **Usage & logs:** select a UTC month, filter outcomes, search the current page, inspect request metadata, and export the filtered page to CSV. Monthly rollups and freshly flushed logs can update at different times.

## Access and billing

- **API keys:** search by key name/owner/model, filter state or owner, create scoped tokens with optional expiry and IP/CIDR restrictions, and confirm rotation or revocation. Newly generated secrets are shown once and never stored in browser storage. Unlimited token quota does not bypass the user's balance.
- **Users:** manage authorized roles, enable/disable accounts, and set a remaining balance in quota units. Console balance writes include `expectedQuota`; if billing or another operator changes that balance before the write, the edit fails rather than overwriting concurrent changes. This is an internal allocation, not a payment.
- **Pricing:** model overrides, mappings, and group ratios require confirmation. Defaults remain in the built-in catalogue when no override exists.
- **Redemption:** generate credit codes after confirming their quantity and value, then copy and distribute them privately. Save a newly generated batch before generating another.

## System

- **Audit trail:** inspect allowlisted event details and export the filtered page. CSV exports neutralize formula prefixes. Neither raw credentials nor arbitrary event payloads are exported.
- **Deployment:** root-only cron-job.org configuration and readable schedules. “Configured” means saved setup metadata, not proof of successful execution. Verify run history at the scheduler.
- **Settings:** appearance preferences, signed-in account details, and non-secret stored settings. Stored settings do not modify hosting environment variables.
- **API reference:** cURL, JavaScript, and Python quickstarts, authentication, endpoint overview, and troubleshooting.

## Navigation and preferences

Use the collapsible sidebar on desktop or the navigation drawer on mobile. `Ctrl+K` / `Cmd+K` opens quick search; use arrows and Enter to navigate, or Escape to dismiss. Native dialogs trap focus and can be dismissed with Escape. Theme and sidebar preferences are the only values saved in localStorage; system theme follows the operating system.

## Safety and limits

The playground never sends a request before confirmation. It keeps the entered key in component memory, uses only the current gateway origin, rejects redirects, waits at most 60 seconds, and caps displayed responses at 1 MiB. The form limits output to 2,048 tokens. Stopping the client does not guarantee upstream cancellation or avoid charges. Copied cURL uses `$FEMBOY_API_KEY`, not the key entered into the form.

Filters labeled “on this page” are client-side filters over the current result page. CSV exports are page-scoped, not exhaustive database exports. User roles remain enforced on the server; role-aware navigation is a usability layer, not the security boundary. Console accounts created without a password cannot use password sign-in until a trusted operator establishes credentials.
