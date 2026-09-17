# Landing page design brief

The landing page introduces gateway software that you host yourself. It is not a
model subscription and not a generic startup pitch.

## Current direction

The product is a router: one key arrives, the gateway elects a provider channel,
and the request leaves through an account you own. The page is built around that
mechanic instead of a slogan.

### Design prompt

> Design the front door for an independently built AI gateway whose name is a
> joke and whose internals are not. Open with the routing decision itself, as
> something the reader can operate, not a static diagram or a headline with a
> gradient. One house pink carries the live request path and nothing else; a
> mint marks healthy upstreams. Set Archivo across its weight and width axes so
> display type has real presence, and keep IBM Plex Mono for the things a reader
> would actually copy: paths, channel ids, numbers. Left-aligned, hard corners,
> no card grid. Number only the content that is genuinely a sequence. No
> tracked-out capital labels, no arrows appended to link text, no invented
> metrics, no scroll-triggered entrance animations.

### Why this replaced the previous revision

The previous revision was an off-white and ink editorial layout with a
terracotta accent, hairline rules, tracked-out capital eyebrows above every
heading and `01 / 02 / 03` markers on content that was not ordered. Those are
the house style of generated pages rather than choices about this product, and
the result read as generic. The single largest cause was typographic: one
weight of one family across the whole page, so nothing had emphasis.

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#ffffff` | `#15101a` |
| Panel | `#ffffff` | `#1c1622` |
| Ink | `#17121c` | `#f4eef7` |
| House pink | `#d6005e` | `#ff4d94` |
| On pink | `#ffffff` | `#17121c` |
| Healthy | `#0f7f6a` | `#5fe3c4` |

Pink appears in four places only: the monogram, the primary action, the elected
route and focus. Dark is the product's native mode; light is a white-and-pink
counterpart rather than a cream one.

## Typography

Archivo (SIL OFL 1.1) is self-hosted as one variable file with weight and width
axes, replacing IBM Plex Sans. Display type runs at `wght 880, wdth 114`; body
at `wght 400`. The console keeps the normal width at lighter weights. Axis
values are set through `font-variation-settings` because `next/font/local` does
not emit a `font-stretch` range. IBM Plex Mono is unchanged.

The Archivo licence is at `public/fonts/archivo-OFL.txt`. The Latin subset came
from the Google Fonts CSS API; the application serves it, so the browser makes
no third-party font request.

## The routing example

The hero panel lists channels in the order the gateway evaluates them. Taking a
channel down moves the election to the next healthy one; taking all of them down
shows the 503 outcome and states that no quota is spent. It runs no requests,
holds no credentials and is labelled as an example. The page-load pulse is the
only motion that a reader does not trigger, and it is suppressed under
`prefers-reduced-motion`.

## Implementation boundaries

- Only landing-page presentation, the shared colour and type tokens, the font
  assets and this brief change.
- Console behaviour, server logic, credentials, database settings and
  maintenance jobs are untouched. The console inherits the tokens and the new
  family; its layout is unchanged.
- Request examples use environment-variable placeholders. The page sends no
  model requests.

## Review gates

Typecheck, tests, billing invariants and the secret scan, then a production
build. Audit the built output rather than the dev server: `next dev` rewrites
`.next`, and a dev server started after a build will serve a page with no CSS,
which silently passes contrast and overflow checks.

Verified on the production build: no automated accessibility violations and no
page-level horizontal overflow in light and dark at 320, 360, 390, 768, 1024,
1440 and 1920 content pixels; routing failover, the all-channels-down state and
the reset control; keyboard focus on every control; light, dark and system
themes.
