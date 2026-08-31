# Base app visual fidelity ledger

Concept reference: `C:\Users\10122\.codex\generated_images\01a055b9-75fe-7952-918c-148ac5b657fa\exec-21d4c7bd-0ea4-4b1a-b532-df0dad6c07d3.png`

| Comparison point | Concept evidence | Browser render evidence | Resolution |
| --- | --- | --- | --- |
| Shell and hierarchy | Quiet full-width header, large task headline, workflow plus result rail, footer | The 1536 CSS-pixel render preserves the same ordered regions and two-column hierarchy | Matched with a 1420px maximum content width and responsive single-column continuation |
| Palette | True white, near-black navy, cobalt controls, pale cool result surface, lime only for a successful result | Browser uses `#fff`, `#08111f`, `#0a43f5`, `#f9fbff`, and reserves lime for `SAFE`/`CAPTURED` | Matched; removed the initial result-rail gradient |
| Product controls | Guard selected, Capture alternate, URL and expectation inputs, three-line-item quote, one primary action | Browser exposes the same controls with semantic radio, label, textbox, definition-list, and button roles | Matched; quote values come from production instead of static copy |
| Truthful initial state | Concept illustrates a completed `SAFE` result | Browser begins at `READY` and says no work starts before verified payment | Intentional deviation: avoids presenting a fictional completed observation; successful deliveries render real `SAFE`, `CHANGED`, or `CAPTURED` data |
| Typography and spacing | Compact bold wordmark, editorial headline, low-to-medium density, generous gutters | Browser uses a 42–58px headline, compact heavy brand, 8px-derived rhythm, and 10–14px radii | Matched within system-font availability |
| Mobile continuation | Compact one-column form, quote reflow, action, safety note and footer | 390×844 check has no horizontal overflow; result moves below the form and quote becomes a 2+1 layout | Matched with functional navigation retained |
| Safety/payment affordance | Explicit Base, price, margin, public-only boundary, no custody | Live values are `$0.03 USDC`, `$0.027`, Base mainnet, x402 v2, and no custody; missing wallet fails without a payment attempt | Matched and functionally verified |

The browser emitted no console warnings or errors during desktop and mobile acceptance. The generated concept remains a design reference only; no raster mockup is shipped in the app.
