# Select Unification QA

## Comparison target

- Source visual truth path: `C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-0d900fb3-80f8-4a9b-9549-091becc4adff.png`
- Implementation screenshot path: unavailable
- Viewport: unavailable
- Source pixel dimensions / CSS size / density normalization: source screenshot supplied in the conversation; no implementation capture was available, so normalization and a visual comparison were not possible.
- State: an open service-selection menu. The implementation changes the running React selection fields to the existing shared `suzu-design-system` `Select` component.

## Full-view comparison evidence

No browser-rendered or app-rendered implementation screenshot is available. The Browser Choice rule prevents opening a browser without the user's selected browser, so no code-only visual comparison was made.

## Focused region comparison evidence

Not performed: the open-dropdown region cannot be compared without an implementation capture at the same state.

**Findings**

- [P2] Visual comparison is blocked by the missing implementation capture.
  Location: all changed selection fields.
  Evidence: the source screenshot is available, but there is no captured running-app dropdown at a matching viewport and open state.
  Impact: typography, spacing, tokens, image fidelity, and copy cannot be visually verified without pretending code inspection is visual QA.
  Fix: open the changed screens in a user-selected browser or the desktop app and capture an open dropdown at the matching state.

## Required fidelity surfaces

- Fonts and typography: not visually verified.
- Spacing and layout rhythm: not visually verified.
- Colors and visual tokens: not visually verified.
- Image quality and asset fidelity: no image assets are changed; not visually verified.
- Copy and content: existing labels and option text were preserved in code; not visually verified.

## Comparison history

No P0/P1/P2 visual iteration has been completed because the rendered implementation is unavailable for comparison.

## Implementation checklist

1. Capture the open shared Select in the updated screens with an approved browser or desktop-app workflow.
2. Compare it with the supplied source screenshot at a matched viewport.
3. Resolve any resulting P0/P1/P2 visual differences and repeat the capture.

final result: blocked
