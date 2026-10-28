# Site and console design brief

The site introduces gateway software that you host yourself. It is not a model
subscription and not a generic startup pitch. The landing page and the console
share one visual language: a cozy closet.

## Current direction

The product is a router: one key arrives, the gateway elects a provider channel,
and the request leaves through an account you own. The page is built around that
mechanic. Channels are garments hanging on a rail in priority order; the
gateway walks the rail and takes the first healthy one.

### Design prompt

> Design the front door and the console for a self-hosted AI gateway as a warm,
> comfortable place: a pink closet with clothes on a rail. Flat vector
> illustrations with navy outlines, coral and blush grounds, cream paper cards
> with dashed stitching, hang tags and grommets. Young Serif for display type,
> Nunito for everything people read, a little Caveat for short handwritten
> notes, IBM Plex Mono for anything a reader would copy. Rounded corners and
> pill buttons with a small hard shadow. Plain, accurate copy: no jokes, no
> invented metrics, no testimonials, no scroll-triggered entrance animations.

### Why this replaced the previous revision

The previous revision was a hard-cornered white and magenta layout set in
Archivo. It was tidy but cold, and it did not match the product's name or the
reference the owner supplied (a pink closet page with illustrated garments).
This revision keeps the routing mechanic as the centrepiece and changes the
material: illustration, warmer colour, softer type and shapes.

## Palette

The landing page keeps one fixed palette in every colour scheme; its tokens are
local to `.site` in `app/landing.module.css`.

| Role | Value |
| --- | --- |
| Coral (hero, closing band) | `#ff5a78` |
| Blush (page ground) | `#ffe3e9` |
| Cream / paper (cards, tags) | `#fff8f4` / `#fffaf6` |
| Ink (text, outlines, rail) | `#2a2550` |
| Berry (elected route, links) | `#e0245e` / text `#c41a52` |
| Olive (healthy) | `#e3eec4` / text `#4c6e14` |
| Lavender (providers band) | `#e2ddf0` |

The console, sign-in page and deployment guide use the same family through the
theme layer in `app/cozy.css`, with light and dark variants.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#fff0f3` | `#1c1830` |
| Surface | `#fffbf8` | `#252040` |
| Text | `#2a2550` | `#fff1f3` |
| Muted text | `#625c84` | `#bcb3d8` |
| Accent | `#c41a52` | `#ff7d9c` |
| On accent | `#ffffff` | `#1c1830` |
| Healthy | `#4a6b12` on `#e6f0c9` | `#c4de85` on `#2e3a24` |
| Banner | `#ff5a78` | `#3a2f5f` |

Text and pill colours were chosen to meet WCAG AA (4.5:1) against the grounds
they sit on.

## Typography

All families are SIL OFL 1.1, self-hosted Latin subsets loaded through
`next/font/local`, so the browser makes no third-party font request. Licences
sit next to the files in `public/fonts/`.

- Young Serif 400: headings, stat values, the brand wordmark. Numbers use
  `lining-nums`.
- Nunito (variable 300–900): body copy and every console control.
- Caveat (variable 500–700): short handwritten notes only (eyebrows, sidebar
  group labels, sign-in kicker).
- IBM Plex Mono 400: paths, ids, keys, code.

## Imagery

Illustrations live in `public/images/` as transparent WebP: a hanging sweater
with a hang tag (hero), four garments for the routing rail, a key tag, coin jar
and wardrobe (ownership cards), a desk (integration band and the console
welcome banner), a yarn basket (deployment), a coat rack (sign-in) and a hanger
(empty states). They are decorative and carry empty `alt` text.

## The routing example

The garments hang in the order the gateway evaluates channels. Tapping a
garment takes its channel down and the election moves to the next healthy one;
taking all of them down shows the 503 outcome and states that no quota is
spent. A reset control restores the rail. It runs in the browser only: it sends
no requests and holds no credentials. Transitions and animations are switched
off under `prefers-reduced-motion` by the global rule in `app/globals.css`.

## Implementation boundaries

- Presentation only: landing markup and styles, the console theme layer, the
  sign-in layout, decorative images, font assets and this brief.
- Console behaviour, API calls, server logic, credentials, database settings and
  maintenance jobs are untouched.
- Request examples use environment-variable placeholders. The page sends no
  model requests.

## Review gates

Typecheck, tests, billing invariants and the secret scan, then a production
build. Audit the built output rather than the dev server: `next dev` rewrites
`.next`, and a dev server started after a build will serve a page with no CSS,
which silently passes contrast and overflow checks.

Check the landing page, sign-in, deployment guide and console (overview, a
table page, an empty state, dialogs, the mobile drawer and the collapsed
sidebar) in light, dark and system themes, with no page-level horizontal
overflow from 320 to 1920 pixels.
