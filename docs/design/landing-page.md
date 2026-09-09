# Landing page design brief

The landing page is a product introduction for an independent, self-hosted AI gateway—not an AI model subscription or a generic startup pitch.

## Researched direction

The previous design leaned on a centered slogan, glowing generated artwork, a blue/purple palette, repeated boxed features and a long mobile scroll. This revision replaces those conventions with a compact, technical editorial layout.

### Adapted design prompt

> Design an independent developer tool, not an AI-startup template. Make the product and its technical specifics do the selling. Use IBM Plex Sans with restrained IBM Plex Mono annotations, an off-white/ink palette, asymmetric columns, fine rules and small functional radii. Show a clearly labelled, interactive configuration example rather than invented activity. No glowing hero artwork, gradient headlines, decorative card grids, fake metrics or motivational filler. Use direct language. Keep the mobile version concise without hiding essential product information. Preserve keyboard access, readable text, reduced-motion support and both color themes.

This brief adapts ideas from the sources below; it is not a verbatim prompt or an instruction to install third-party tooling.

## Sources and application

- [Anthropic: Prompting for frontend aesthetics](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics) — specify typography, composition and common defaults to avoid. Applied as a coherent technical direction; recommendations for decorative gradients and motion were deliberately not adopted.
- [Google: Stitch Prompt Guide](https://discuss.ai.google.dev/t/stitch-prompt-guide/83844) — give concrete visual constraints, then review individual components. Applied to navigation, the product example, code and small-screen states.
- [Vercel: Typography](https://vercel.com/geist/typography) — distinguish headings, labels, copy and monospace annotations. Used as a hierarchy reference, not a copied template or brand treatment.
- [IBM Plex](https://github.com/IBM/plex) — self-hosted Sans and Mono fonts, licensed under SIL OFL 1.1. The font license is included at `public/fonts/ibm-plex-OFL.txt`. Latin webfont subsets were obtained via the Google Fonts CSS API; no font package or telemetry dependency was installed.

## Implementation boundaries

- Only landing-page presentation, related assets and this brief change.
- Console behavior, server logic, credentials, database settings and maintenance jobs remain unchanged.
- Product previews are explicitly examples, not live workspace state.
- Request examples use environment-variable placeholders. No model requests are made by the page.
- Fonts are served by the application. The page makes no Google Fonts requests in the browser.

## Review gates

Check the fresh-checkout typecheck before the first Next build, then tests, billing invariants, secret scans and production build. Test light/dark/system themes, keyboard tabs, copy behavior, mobile navigation, FAQ expansion and 320-content-pixel minimum width. Inspect rendered states individually. Publish only after the landing page has no page-level overflow or automated accessibility violations in the tested states.
