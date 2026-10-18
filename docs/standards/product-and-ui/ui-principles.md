# Kala UI Principles

Use these principles when designing or changing Kala product interfaces. They
apply to the Dashboard, embedded browser UI, and Desktop WebView unless a
platform-specific constraint is documented.

## Product character

Kala is a focused working environment, not a decorative landing page.

- Prefer calm, direct, information-dense interfaces.
- Preserve clear hierarchy without surrounding every item with a card.
- Keep the primary task visually dominant; move diagnostics and secondary
  controls behind deliberate disclosure.
- Reduce padding and ornament before reducing readable type.
- Use motion to explain continuity or state changes, never as ambient noise.
- Keep behavior and terminology consistent across desktop, mobile, and narrow
  layouts.

## Layout and interaction

- Build from semantic page, panel, section, row, and control patterns rather
  than one-off dimensions.
- Preserve touch targets even when visual chrome is compact.
- A collapsed navigation surface must retain an obvious restore control.
- Truncation is allowed only when the complete value remains accessible.
- Progressive disclosure must not hide required error recovery or approval
  actions.
- Loading, empty, error, disconnected, and permission states are first-class
  product states, not afterthoughts.

## Visual hierarchy and surfaces

Use hierarchy to direct attention, not to decorate every data boundary.

- Compose surfaces in the order Canvas → Panel → Section → Row → Control.
- Do not express hierarchy by repeatedly nesting cards. Prefer spacing,
  background steps, headings, and grouping before adding another container.
- Use borders for real boundaries, input affordances, and precise separation;
  avoid turning the interface into a grid of outlined boxes.
- Keep one dominant visual focus per viewport. Secondary panels and diagnostic
  information must not compete with the primary task.
- A region should normally have one primary action. Additional actions are
  secondary, contextual, or progressively disclosed.
- Elevation and shadows communicate overlap. Do not add them to static content
  merely to make it appear more important.

## Spacing, density, and control sizing

- Use the shared spatial scale: 4, 8, 12, 16, 24, and 32 CSS pixels. Introduce
  an intermediate value only when a shared component has a demonstrated need.
- Align related text, icons, and controls to common edges. Small alignment
  errors are more damaging than small spacing differences.
- Compact, default, and comfortable presets must adjust type, row height,
  control size, gaps, and padding together.
- Density may expose more information, but must not hide required information,
  weaken contrast, or reduce essential text below its semantic minimum.
- Desktop pointer targets should normally be at least 36–40px. Touch-oriented
  layouts should provide at least 44px targets, even when the visible icon is
  smaller.
- Components with the same role must use the same height and internal spacing
  across Chat, Inspector, Settings, and navigation surfaces.

## Responsive and adaptive behavior

- Resolve constrained space in this order: reflow, collapse, progressively
  disclose, then truncate. Do not scale the whole interface down to make it
  fit.
- Mobile is an intentional composition, not a reduced Desktop screenshot.
- Define breakpoints where content begins to collide or lose meaning, rather
  than choosing them only from conventional device widths.
- When a multi-panel layout narrows, preserve the primary task and collapse
  auxiliary panels in a documented priority order.
- A collapsed or dismissed navigation surface must retain an obvious,
  keyboard-accessible restore control.
- Horizontal scrolling is acceptable for content that is intrinsically wide,
  such as code, diffs, tables, and timelines. It must not conceal a broken
  application layout.
- Test long English labels, Simplified Chinese, identifiers, zoom, safe-area
  insets, virtual keyboards, and split-panel resizing.

## Interaction states and feedback

- Interactive components define default, hover, pressed, focus-visible,
  selected, disabled, and loading states.
- Hover is an enhancement, never the only way to discover information or an
  action.
- Never remove a useful focus indicator. Focus rings must remain visible and
  must not be clipped by surrounding overflow.
- Preserve a logical keyboard order that follows the visual and semantic
  structure.
- Give immediate local acknowledgement after an action. Operations that do not
  settle promptly must expose a pending state without freezing unrelated UI.
- Disable or deduplicate repeated submission while an operation is pending.
- Optimistic changes must roll back or reconcile visibly when the operation
  fails.
- Selected, focused, hovered, and merely expanded are different states and
  must not share an ambiguous visual treatment.

## System states, recovery, and trust

- Define loading, empty, offline, stale, partial, permission-denied, unknown,
  and error states for every data-bearing surface.
- Never render an unconfirmed result as success. Use pending or unknown until
  the authoritative state is available.
- Put errors next to the failed action or affected content. Toasts are for
  transient acknowledgement, not the sole home of an actionable failure.
- Explain errors in this order: what happened, what is affected, and what the
  user can do next.
- Preserve user input across recoverable failures. Never silently discard a
  draft, selection, or pending configuration.
- Technical identifiers may be copyable for diagnosis, but must remain
  secondary to a human-readable explanation.
- Destructive actions state the target, scope, consequence, and whether
  recovery is possible. Confirmation wording must name the actual action.
- Degraded or partially available data must be labeled honestly; do not use
  success-shaped placeholders or silent fallbacks.

## Accessibility

- WCAG 2.2 AA is the minimum target, not a final polish pass.
- Normal text and important controls require at least 4.5:1 contrast; large
  text, graphics, focus indicators, and component boundaries must meet their
  applicable contrast requirements.
- Color is never the only status signal. Pair it with text, shape, iconography,
  position, or another durable cue.
- Every product action must be operable by keyboard with a predictable focus
  order and a visible focus state.
- Icon-only controls require an accessible name and, when the action is not
  obvious, a discoverable tooltip.
- Associate validation and help text with the relevant control. Placeholder
  text is not a label.
- Announce meaningful asynchronous changes without repeatedly interrupting
  assistive technology.
- Respect reduced-motion, forced-colors, browser zoom, text scaling, and
  operating-system contrast preferences without removing functionality.

## Typography

Typography is a system-level interface primitive. Do not fix local text quality
by adding arbitrary font sizes, synthetic weights, or platform-specific
font-smoothing.

### Font ownership and delivery

Kala self-hosts versioned fonts through pinned package dependencies:

- **Inter Variable** for Latin UI text and numbers.
- **Noto Sans SC Variable** for Simplified Chinese and mixed Chinese text.
- **JetBrains Mono Variable** for code, commands, paths, hashes, and machine
  identifiers.

Font assets are dependency and release artifacts. Do not commit `.woff`,
`.woff2`, `.ttf`, or `.otf` binaries to Git. `node_modules`, Dashboard `dist`,
and generated release archives remain untracked. Do not load fonts from a CDN
or any runtime third-party origin.

The default family order is Inter, Noto Sans SC, then system sans-serif
fallbacks. A Chinese document locale uses Noto Sans SC before Inter so one
family renders the complete mixed-language run where possible. Monospace is a
semantic role, not a styling accent.

### Rendering contract

- Keep the root font size at `16px`.
- Do not scale the entire interface by changing the root font size.
- Use real variable-font weights: 400 regular, 500 medium, and 600 semibold.
- Disable synthetic bold and italic with `font-synthesis: none`.
- Enable normal kerning and automatic optical sizing.
- Leave platform font smoothing at `auto`; do not globally apply Tailwind's
  `antialiased` utility or force grayscale smoothing.
- Use tabular numerals only for changing numeric values such as durations,
  counters, and aligned metrics.
- Avoid animated clipping or transparency on ordinary text. Motion effects
  must preserve a stable, normally rendered text layer.

### Semantic type scale

The default UI uses a small set of semantic roles with integer CSS-pixel
metrics:

| Role | Size / line height | Weight | Use |
|---|---:|---:|---|
| `caption` | 12 / 16 | 400 or 500 | Short timestamps, counts, tertiary metadata |
| `meta` | 13 / 18 | 400 or 500 | Secondary labels and supporting UI text |
| `ui` | 14 / 20 | 400 | Controls, menus, forms, panels |
| `ui-emphasis` | 14 / 20 | 600 | Selected items, important state, action labels |
| `body` | 15 / 24 | 400 | Conversation and long-form product copy |
| `title` | 16 / 24 | 600 | Dialog, panel, and section titles |
| `heading` | 20 / 28 | 600 | Page-level headings |
| `code` | 13 / 20 | 400 or 500 | Code and machine-readable values |

Use the corresponding Tailwind utilities (`text-caption`, `text-meta`,
`text-ui`, `text-ui-emphasis`, `text-body`, `text-title`, `text-heading`, and
`text-code`). Do not introduce arbitrary `text-[...]` sizes when one of these
roles fits.

Important content must not be smaller than 13px. The 12px caption role is
reserved for short, tertiary information. Never use 10px or 11px for content
the user must read or act on.

### Interface sizing

Interface sizing uses named, discrete presets instead of continuously scaling
the root `rem`:

| Preset | Purpose |
|---|---|
| `compact` | Dense desktop work without reducing essential text below its minimum |
| `default` | Standard balanced layout |
| `comfortable` | Larger controls and type for distance and touch use |

Each preset maps semantic roles and spatial tokens to intentional values.
Browser zoom remains the accessibility mechanism for arbitrary whole-page
scaling. Existing numeric preferences may be migrated for compatibility, but
must resolve to a named preset before styles are applied.

### Language and content

- Set the document `lang` attribute to the active locale.
- Chinese UI should use Noto Sans SC for the complete mixed-language run where
  possible.
- Do not add tracking to Chinese body text.
- Use sentence case for controls and labels.
- Keep line lengths and line heights suitable for reading; Chat body defaults
  to 15/24.
- Preserve user-authored whitespace where it carries meaning, without forcing
  artificial line breaks into content.

### Markdown and technical text

Kala's existing Markdown renderer remains authoritative because it integrates
code, math, diagrams, Tool output, and streaming behavior. It consumes the same
semantic type tokens; do not wrap the entire product in a generic prose plugin.

Use monospace only for code, terminal content, commands, paths, hashes, JSON,
and identifiers. Human-readable status, names, durations, and descriptions use
the sans family. Dynamic numeric values may use tabular numerals without
switching families.

### Typography acceptance

Typography changes must be checked in:

- Chromium on Linux at device pixel ratios 1 and 2.
- Windows Edge or Desktop WebView at 100% and 125% system scaling.
- macOS Chrome or Safari where available.
- Desktop, mobile, and narrow split-panel layouts.
- English, Simplified Chinese, and mixed-language content.
- Light and dark themes.
- Chat, Composer, Sidebar, Inspector, Settings, dialogs, code blocks, and
  terminal-adjacent UI.

Verify computed font family, size, line height, and weight. Check font loading
for layout shift and offline behavior. Build and inspect the release asset
inventory. Run repository privacy checks and confirm no font binary is tracked
by Git.

## Content design and localization

- Use specific verbs for actions. Prefer “Deploy Dashboard” or “Retry upload”
  over context-dependent labels such as “Continue” or “OK”.
- Status text describes the current fact; action text describes what will
  happen next.
- Use sentence case. Do not use all caps as a substitute for hierarchy,
  especially in Chinese.
- Format dates, durations, numbers, byte sizes, and relative time through
  shared locale-aware formatters.
- Truncated content must remain available through expansion, a detail surface,
  or an accessible tooltip.
- Allow for translation expansion and different line-breaking behavior. Do
  not size a control around one English label.
- Preserve user-authored language and whitespace where meaningful. Product
  copy should be concise without becoming cryptic.

## Forms and settings

- Keep labels visible and persistent. Descriptions explain effect, scope, or
  risk instead of repeating the label.
- Use a switch for an immediate Boolean setting, a segmented control for a
  small mutually exclusive set, and a numeric input or slider only for a
  genuinely continuous value.
- Validate immediately only when the user can act on the feedback while
  editing. Validate remaining constraints on blur or submit.
- Keep error text adjacent to its control and preserve the submitted value.
- Distinguish autosaved, saving, saved, unsaved, and failed states.
- Separate advanced or dangerous settings from ordinary preferences through
  structure and explanation, not only color.
- Reset actions state whether they affect one value, the current section, or
  all settings.

## Dialogs, popovers, and progressive disclosure

- Use a modal for a short blocking decision or focused edit that must preserve
  surrounding context. Move complex workflows to a page or dedicated panel.
- Do not nest modal dialogs.
- A dialog must trap focus, choose a sensible initial focus, support Escape
  when safe, and restore focus to its trigger when closed.
- Closing an overlay must not silently discard meaningful input.
- Popovers contain lightweight contextual controls or information, not long or
  irreversible workflows.
- Convert constrained popovers to a sheet or full-width surface on small
  screens.
- Progressive disclosure may reduce noise, but must not hide active errors,
  approvals, security consequences, or recovery actions.

## Technical and data-dense interfaces

- Logs, traces, JSON, diffs, and terminal-adjacent views may be denser than
  ordinary product UI, but still require readable hierarchy and navigation.
- Use monospace for machine-readable values, not for human-readable status,
  durations, names, or descriptions.
- Align comparable numbers and use tabular numerals. Keep prose and labels
  left-aligned.
- Paths, hashes, and identifiers should support copy without dominating the
  default view.
- Encode additions, removals, warnings, and failures with text or symbols as
  well as color.
- Long lists, transcripts, logs, and trees require bounded rendering,
  virtualization, search, or progressive loading.
- Wrapping, horizontal scrolling, and truncation must be explicit per content
  type instead of inherited accidentally.

## Iconography

- Icons identify a stable object or action; they are not filler for empty
  space.
- Reuse one icon for the same concept throughout the product.
- Keep stroke weight, optical size, and filled versus outlined style
  consistent within one control group.
- When an icon and text appear together, the text carries the precise meaning
  and the icon accelerates recognition.
- Status icons must reinforce, not replace, status text and accessible names.
- Decorative icons are hidden from assistive technology.

## Color and contrast

- Use semantic color tokens rather than literal component colors.
- Muted text remains readable; do not combine the smallest type role with the
  weakest contrast for actionable information.
- Color cannot be the only signal for status or error severity.
- Light and dark themes must preserve hierarchy rather than merely invert
  colors.

## Motion

- Motion communicates state, direction, and continuity.
- Repeating animations must have identical visual start and end frames.
- Prefer compositor-friendly transforms and opacity where they preserve text
  clarity.
- Honor `prefers-reduced-motion`.
- Streaming, progress, and transition effects must not alter layout or prevent
  selection and copying.

## Performance and visual stability

- Font, image, and asynchronous data loading must not cause avoidable layout
  shift.
- Skeletons reserve approximately the final content geometry; do not use large
  flashing placeholders unrelated to the result.
- Keep long sessions responsive through bounded DOM size, virtualization, and
  incremental rendering.
- Prefer transform and opacity for animation when they preserve text clarity.
  Avoid continuous layout, paint, or filter work.
- Limit the area and number of blur, backdrop-filter, large shadow, and
  transparency effects.
- Under constrained resources, preserve legibility and interaction before
  decorative effects.

## Consistency and exceptions

- Tokens and shared primitives are the default source of truth. Do not copy a
  nearly identical local component to avoid improving the shared one.
- Before adding an arbitrary size, color, spacing, radius, shadow, or z-index,
  demonstrate why an existing semantic token cannot express the requirement.
- A pattern repeated three times should become a primitive, variant, or token
  unless the contexts are semantically different.
- Necessary exceptions document their reason, scope, owner, and removal
  condition near the implementation or governing design document.
- Review consistency across surfaces and states, not only whether an isolated
  screenshot looks attractive.
- New principles should be enforceable through shared components, tests,
  linting, or an explicit review checklist wherever practical.

## Validation and change discipline

- Update shared primitives before applying repeated one-off fixes.
- Add regression coverage for tokens and critical responsive behavior.
- Exercise keyboard navigation, focus restoration, screen-reader names,
  reduced motion, zoom, and contrast for affected interactions.
- Verify default, loading, empty, error, stale, disabled, and recovery states.
- Validate focused components, then the complete Dashboard typecheck and
  production build.
- Check generated asset size and offline loading when adding fonts or media.
- Keep deployment-specific values, credentials, hostnames, user content, and
  local absolute paths out of source, tests, screenshots, and commits.
