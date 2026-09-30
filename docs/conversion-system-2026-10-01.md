# DELTA — Visibility, perceived value and paid-use conversion

Status: execution specification and first copy draft, not a deployed redesign or measured conversion improvement.
Owner mandate received 2026-10-01: make more people see DELTA and make the need for using it legible through sensory design, content and consumer psychology; the operator owns all required work within existing authority.

## Control and commercial objective

Reuse task `6a9699b9f8308191a104d805bfa57c43`, titled `全力冲刺50000usdc`, its hourly cadence, repository and existing identities. This document adds a buyer-facing conversion workstream, not a new loop, spending authorization, pricing change or deadline. The primary target remains independently verified genuine customer revenue toward 50,000 USDC. Revenue is not profit. Preserve the closed September 14–21 sprint and all actual ledgers.

Read AGENTS.md, the current owner pricing policy, the delegation note and CURRENT_REVENUE_HANDOFF before execution. Treasury and genuinely actionable buyer/payment threads remain first. At least 80% of non-security/non-reconciliation effort stays on buyer-facing conversion, qualified acquisition, paid fulfillment, integration and genuine repeat use. Content/UI work qualifies only when tied to a specific buyer decision or measured friction, not decorative redesign for its own sake.

## Core commercial idea

中文主张：**行动之前，留住依据。**
English candidate: **A record of the source. Before you act.**

Working explanation: DELTA observes a retrievable public page, records observation metadata and content hashes, and can compare a fresh observation against specified conditions. The product is an observation checkpoint, not a certificate that a source is true, a purchase will succeed, a website is safe, or evidence will be admissible in court.

A URL points to a location; the business need to investigate is whether a buyer must later account for what was observed at a decision boundary. Do not claim that everyone needs DELTA or that other recordkeeping methods are inherently inadequate. Qualification must establish a real gap relative to the buyer's existing records. Necessity is conditional on that gap, not manufactured anxiety.

Two audiences require two coherent surfaces:
- A human decision maker needs a recognizable situation, tangible deliverable, credible limits, understandable cost and easy next action.
- An authorized software/agent buyer needs correct schema, selection criteria, exact price/network, supported output, bounded cost, idempotency and verification. A more beautiful page is not an agent purchasing policy. Never insert instructions that override another agent's budget, tool-selection rules or owner authority.

## Evidence inspected in this run

- README.md: current positioning is 'Trust Layer for Autonomous Actions'; raw artifacts remain private; public verifier exposes metadata/hashes. A historical demo proof is explicitly legacy_unverifiable. Do not relabel that legacy proof as verified.
- channels/base-app/src/App.tsx, blob b318f8e012c3224209592d117ea8142ae43ae858: the first viewport moves from a short headline into product selection, target input and wallet purchase. An external proof-verifier link exists, but the result rail is empty before a delivery. No embedded worked example appears in this source.
- The same file calls Public Preflight 'Guard' and displays 'SAFE' for `safe === true`. This wording may overstate deterministic rule matching; presentation should say 'Specified conditions matched' and retain actual reason/conditions.
- channels/base-app/src/domain.ts, blob d8b4b36826c4047a454cd8a382189d1e36c37c9b: a valid output includes proof_id, public_proof_url, manifest_url, bundle_root, observed_at and optional rule-comparison fields. The browser flow uses an injected compatible wallet and canonical Base payment validation. The product, target and conditions are encoded in the page URL.
- These are SOURCE observations, not a completed live visual, mobile or paid end-to-end audit. Direct native-web retrieval of the public homepage/app and Treasury transfer endpoint failed in this run; container public-repository retrieval failed DNS. Those failures are not proof of product outage or zero receipts.

## First execution order and acceptance gates

### P0 — Explain the deliverable before asking for a wallet

Create a reusable, visibly labelled sample observation panel inside the EXISTING purchase experience. Fields should map to the actual delivery schema: public URL/source, observation time, proof reference, content or bundle fingerprint, and exact check result when present. Any invented scene/data is labelled 'Illustrative example — not a live capture or paid customer result'. A mock hash cannot masquerade as an issued DELTA proof; use non-hex placeholders or a local-only simulation label.

Primary informational action: view a worked example. Primary transactional action after selecting a genuine target: review the live quote, then explicitly authorize the existing purchase. Never connect/sign/charge merely by opening a sample or page. Keep examples separate from a live request; never auto-run a billable example.com target. Preserve the existing valid payment policy, canonical pay-to and price gates.

Show what is and is not delivered. A hash alone cannot reconstruct original text. Raw artifacts being stored privately does not establish a buyer-download entitlement. If a buyer needs the original text, screenshot, retention commitment or export and the supported authorized path cannot provide it, record a product gap and do not sell an invented archive. Never promise permanent preservation.

Acceptance: someone can identify the problem, deliverable and relevant moment before wallet connection; sample action makes zero payment/signature requests; real request uses correct live quote and explicit user approval; all production/UI changes pass existing tests and live owner-pricing gates before deployment. Source changes, preview, deployed build and paid end-to-end validation are separate states.

### P0 — Correct the trust and state language

Present deterministic preflight results as 'specified conditions matched', 'specified conditions not met', or 'unable to determine'; show the conditions and reason. Do not equate absence of a match with a malicious source. Distinguish quote, wallet connection, authorization, settlement, observation and delivery. A generic client error does not prove that no payment occurred. Uncertain settlement requires receipt reconciliation and an idempotent recovery path, not a fresh charge.

Acceptance: no blanket 'SAFE', guaranteed truth/safety/legal claim, fabricated success state, or false 'no payment made' after an ambiguous request. Preserve underlying protocol semantics while correcting human-readable labels.

### P1 — Sensory direction

Keep the existing DELTA name/identity. Use an edited document/instrument aesthetic: highly legible typography, generous margins, precise rules, limited semantic color, and one clearly framed observation record. The desired feeling is composure, control and inspectability, not crypto speculation or theatrical cyber-security. Source changes, observation time and comparison result should be the visual focal points.

Motion should explain one event: a public source changes while a previously issued observation record retains its own observation time and fingerprint. Keep this clearly illustrative until backed by a real authorized sample. No fabricated live ticker, emergency warning, certification seal, customer logos, transaction counters, countdown or preselected recurring billing. Support reduced motion, keyboard use, contrast, focus, error clarity and phone-sized screens. Do not hide limits below decorative media.

Generate the concept and required assets with the available image/design tools when proceeding to visual implementation, then verify the actual rendered desktop/mobile experience. Do not claim that this textual direction is already an implemented visual system.

### P1 — Three scenario narratives

1. Public supplier conditions before a recommendation: record an observation supporting a current procurement decision. Do not claim to lock a vendor's terms or guarantee fulfillment/refunds.
2. Public source before citation/publication: attach a traceable observation reference to a citation. Do not claim that a fingerprint authenticates the article's factual accuracy or independently reconstructs its text.
3. Reviewed public page before an enforcement handoff: record observable page state before it changes. Do not replace threat analysis, infringement assessment, screenshots already required by a platform, or legal evidence collection.

Each scenario surface contains the actual buyer role, one decision boundary, a concrete output preview, existing-method comparison, eligibility/limits, current-price purchase path and a single next action. These are hypotheses until a real buyer confirms an unmet need; do not treat published adjacent workflows as funded demand.

### P1 — First content set, ready to refine against actual outputs

Hero: 网页会变。决策要有据可查。
Subhead: 在采购建议、来源引用或处置交接前，为可访问的公开网页记录观察时间与内容指纹。需要核对时，再检查新的观察是否符合你指定的条件。
Primary sample action: 看一份记录示例。
Transactional action: 查看本次报价。
Scope: 记录观察，不认证事实；条件匹配，不等于安全保证。

Post A — 链接还在，不代表内容没变。
Body: 一次决定之后，网页可能已经更新。需要回溯时，你要找的不只是地址，还有当时观察到的状态。先看 DELTA 的记录结构，再判断这一步是否补足你已有的流程。
CTA: 查看记录示例。

Post B — 在决定之前，多留一个可核对的记录。
Body: 不是每次浏览都需要保存。把检查放在真正重要的节点：提交采购建议、引用公开来源、交接已核实的问题页面。针对一个当前任务，确认输出符合需要，再购买一次观察。
CTA: 查看适用场景。

Post C — 你得到的，不是一句“相信我”。
Body: 查看观察时间、记录编号、内容指纹与核对条件。哪些能够验证，哪些不能，由输出本身说明。哈希不能还原原文，条件符合也不意味着页面上的说法真实。
CTA: 看懂一份记录。

20-second storyboard, illustrative until executed: 0–4 seconds show a clearly fictional public terms page; 4–8 show an observation record with labelled placeholders; 8–13 show a later page revision beside that earlier record; 13–17 explain observation versus truth; 17–20 show '行动之前，留住依据' and the sample action. Do not show payment success, live activity or real client names without evidence/permission. No paid diagnostic transaction is needed for the simulation.

### P1 — Distribution that reaches buyers, not just catalogs

Separate eligible buyer exposure, technical discoverability, installed/routable integration and actual purchases. Route a procurement audience to the procurement scenario, not a generic SDK wall; route a developer to the existing schema/quickstart and exact limits. Update existing authorized listings only when a concrete buyer path exists and after price validation. Publish useful scenario demonstrations through existing authorized business/developer/community channels where promotion is allowed; do not create accounts, spam communities or impersonate a customer. Never post customer proofs/URLs or private artifacts for marketing without permission.

Use actual objections from explicit replies to refine the content. No silence follow-ups, guessed emails, suppression evasion, alternative sender identities or tool-safety bypass. A rejection remains a stop even after a redesign. The September 30 reply from 402.coffee says its arbiter does not currently use public-page evidence and declines; preserve that suppression. A new homepage does not reopen the conversation.

### P2 — Repeat use through genuine workflow value

Offer integrations only for actual supported buyer work. A checkpoint can be useful before a recurring consequential action, but do not make every page view billable or secretly convert a one-time purchase into ongoing use. Buyer-approved rules, budgets and finite obligations remain controlling. Demonstrated benefit and recoverable delivery, not lock-in or fear, are the retention mechanism.

## Behavioral design, not guaranteed persuasion

Use motivation/ability/prompt as a diagnostic: give the user a relevant reason, reduce effort, and present the action at a relevant moment. Source: https://www.behaviormodel.org/ . This framework is not a numerical prediction of sales.

Visual quality can affect perceived usability, but good appearance does not establish actual ease, reliability or demand. Test behavior rather than treating 'looks good' as a conversion result. Source: https://www.nngroup.com/articles/aesthetic-usability-effect/ .

Use salience, intelligible outcomes, clear choices and explicit price disclosure. Do not invent quantified avoided losses, false scarcity, reviews, regulatory approval, urgency or customer numbers. No manipulative paywall, concealed terms or prompts aimed at overriding buyer agency.

## Measurement and experiment register

Instrument only within current lawful/authorized analytics capability; do not purchase tracking services or collect extra personal data. Prefer coarse channel/scenario tags and existing request IDs. Do not send raw target URLs, source contents, conditions, email addresses or wallet identities into marketing analytics; keep necessary settlement evidence in its authorized ledger.

Track eligible visits, scenario selected, sample viewed, target entered, live quote shown, purchase initiated, wallet/payment friction, authorized payment, confirmed settlement, Treasury received, fulfillment success and genuine repeat use. Mark bots, operator demos, platform tests and repeated requests separately. Clicks and 402 challenges are not sales.

E1: outcome-first headline and visible sample versus the existing sparse payment form. Primary observation: qualified users can explain the deliverable and proceed to a valid quote. Commercial endpoint: completed genuine paid fulfillment and matching customer receipt, not clicks alone.
E2: show required payment network and prerequisites before the payment action. Primary observation: fewer avoidable wallet failures among actual willing buyers, without hiding the crypto requirement. Alternative payment rails need separate capability/legal/financial review; do not claim they exist.
E3: scenario-matched entry from an existing allowed channel. Primary observation: the buyer's current task is supported and produces a purchase, not registry index growth.

Keep one main hypothesis active when traffic is sparse. Use actual observed sessions/explicit replies, not fabricated user tests. Do not claim A/B significance without adequate data. Change segment/use case/friction after 24/48h without verified progress; the remedy is not automatically more catalogs or more cosmetic work.

## Operator ownership and reporting

The assistant owns research, positioning, copy, visual concepting, buyer-facing implementation within authority, QA, channel suitability, qualified communication, purchase-friction diagnosis, fulfillment and measurement. These are work roles, not claims that external staff or subagents have accepted assignments. Maintain task IDs/states: source audit complete; copy draft complete; visual concept pending; UI implementation pending; rendered QA pending; deployment pending; distribution tests pending; observed commercial result unverified until actual evidence.

Only notify the owner about real customer receipts/settlements, actionable buyer intent, meaningful verified buyer-facing publication/integration, unavoidable new exact-action blocker, core failure or material reconciliation anomaly. Routine work continues in the existing task without repeated 'continue' approvals. Notification settings, wallet restrictions and all previous price/safety boundaries remain unchanged.
