# TRADIE.md — The Rafter Target User

> **What this is.** A grounded, evidence-based persona of the Australian tradesperson Rafter
> serves. It exists to keep product decisions anchored to the *real* user rather than to
> assumptions, internal convenience, or the preferences of any single client.
>
> **Two jobs:**
> 1. **Strategy reference** — a description of who we build for, usable for *any* Rafter
>    feature, not just quoting. Read the front half.
> 2. **Appraisal lens** — a set of failure modes and decision axes to push design options
>    through. Read the back half ("Decision axes" + "How to appraise").
>
> **This is the segment, not Andy.** Andy (2 Men and a Shovel) is the founding client and one
> instance of this persona. He *validates and corrects* the persona; he does not *define* it.
> When a decision turns on "what the tradie needs," reason from this document — then sanity-check
> against Andy as a real example. Do not collapse "the tradie" back into "what Andy happens to
> prefer."
>
> **Evidence is dated.** All citations below were gathered **June 2026**. Behavioural stats,
> adoption research, and competitive context go stale. Refresh the evidence before relying on
> this persona for major decisions in a later year. Cite, don't assume — claims here carry their
> sources so they can be re-checked.

---

## 1. Who the tradie is

A small trade-business operator — solo, or running a crew of a few. One of roughly **1.2 million
people working in Australian trades and construction**, an industry contributing more than
**$150 billion to the economy annually**. [flowtivity-2026]

The defining trait: **he would rather hold a drill than a laptop.** This is not a knock on his
intelligence or capability — it is the operating reality the entire product must respect. He runs
the business on a mix of **handwritten notes, text messages, spreadsheets, and memory.**
[flowtivity-2026] Software is a means to an end (more billable work, less paperwork), never an end
in itself. He has no interest in software for its own sake and no patience for it.

He is a smartphone user as a matter of course, but his relationship with business software is
pragmatic and impatient: it earns its place by saving him time and winning him work, or it gets
abandoned.

### Where he is when he uses Rafter

Quoting and admin happen **between jobs, after hours, or on the move — not at a desk.**
[ayrmont-2025] Picture: in the ute between sites, at the kitchen table at 8pm, on a phone or
tablet, often tired, often distracted. The product has to work well under those conditions —
**low cognitive load, few steps, forgiving of interruption.** It does not need to be
field-surgery-grade (this isn't mission-critical, life-or-death tooling), but it must not demand
a quiet desk and full attention.

---

## 2. The world he operates in

### Admin is a heavy, resented tax

- Australian tradies spend **8 to 12 hours a week on admin** — invoicing, bookkeeping, quoting,
  compliance paperwork, scheduling. [undercurrent-2026]
- At ~$90–120/hr billable, that's **$34,000–$43,000+ a year in lost billable time.**
  [undercurrent-2026] Some sources put quoting+invoicing+paperwork at 5–10 hrs/week and
  $600–$1,200/week in unbilled time. [servicescale-2026b]
- Admin is the enemy. Anything that *adds* to it — even slightly — fights the core value
  proposition.

### Quoting is competitive, and speed wins or loses the job

This is the part that makes Rafter matter, and it raises the stakes on every quoting decision:

- **Customers don't contact just one tradie.** They request multiple quotes and **go with whoever
  responds first and sounds reliable.** [serviceseeking-2026a]
- Customer expectations for fast response are rising — shaped by instant replies everywhere else
  in their lives. Tradies who don't adapt **fall behind even when their work is excellent.**
  [ottomedia-2026]
- "A professional, itemised quote landing in the customer's inbox before you've pulled out of
  their driveway — that speed alone wins jobs." [servicescale-2026b]

**Implication for any quote-related feature:** speed-to-customer is not convenience, it's
competitive. This applies to *revised* quotes too — a slow or clumsy edit can lose a live deal to
a faster rival.

### The quote is a trust artifact, not just a price

- **Customers don't just compare numbers — they compare how each tradie makes them feel.** A
  clear, well-written quote can **beat a cheaper one that feels rushed or uncertain.**
  [serviceseeking-2026b]
- A detailed quote gives customers confidence; many would rather pay slightly more for someone who
  **seems organised and reliable.** [serviceseeking-2026a]

**Implication:** the quote *document* is a professionalism signal. Anything that makes it look
ragged, inconsistent, or uncertain damages the thing that wins the job. This is the evidence base
for Rafter's **"PDF as object" principle** (see §5).

### Reputation is now online word-of-mouth

- **73% of Australians check Google reviews before choosing a tradie;** 89% use Google to find
  local services. [websitebuilder-2026]
- Reviews frequently praise **communication and responsiveness** as much as workmanship — "got
  back to me straight away," "easy to communicate with." [ottomedia-2026]
- Word-of-mouth still matters but the customer journey now starts online: buyers **search,
  compare, read reviews, and judge professionalism before they ever make contact.**
  [websitebuilder-2026]

**Implication:** professionalism and responsiveness compound into reputation, which drives future
work. Features that make the tradie look more organised and responsive have value beyond the
single transaction.

### Cashflow is tight and late payment is normal

- **44% of Australian small-business invoices are paid late.** [undercurrent-2026] Chasing
  payment is a recurring, dispiriting admin loop.
- Subscription tools are judged hard on value — they must visibly pay for themselves (often via
  one or two extra won jobs) or they're cut. [flowtivity-2026]

**Implication:** pricing sensitivity is real, and the tradie is doing a constant
cost-vs-time-saved calculation, mostly unconsciously.

### He already lives in a job-management tool

- **ServiceM8 is the de facto go-to app** for small Australian operators; its standout strength is
  the customer acceptance flow — **the client taps to approve, signs digitally, and can pay a
  deposit, all from their phone.** [servicescale-2026a]
- Solo tradies favour straightforward tools (ServiceM8, Square); bigger crews move to simPRO /
  AroFlo. [trustedtradie-apps] The recurring selection criterion is **"simple enough to use daily
  without slowing down the job."** [trustedtradie-apps]

**Implication for Rafter specifically:** the tradie's home base is his job-management platform
(for the founding segment, ServiceM8). Rafter is a tool he *bounces into* to do a specific thing,
then leaves. Rafter should meet him where he already is rather than demanding he relocate his
working life.

---

## 3. How he makes software live or die — the failure modes

This is the most important section for design. These are the documented reasons tradies (and
small-business operators generally) **abandon** software. Every one is a trap a Rafter feature can
fall into.

### FM-1 — Complexity kills it

The single most common abandonment cause. "We tried it, but the team stopped using it." "Too many
features — confusing." [thinkonic-2025] The repeated selection rule is *don't pick the fanciest
tool if it's too complicated; pick something simple enough to use daily without slowing the job.*
[trustedtradie-apps]

> **Design rule:** every added step, option, or screen is a liability. Default to the fewest
> possible decisions. Fancy is a cost, not a benefit.

### FM-2 — Friction sends him back to manual

When software adds friction, a meaningful share of users **look for a way to do the task manually,
and some refuse to keep using the software at all.** [techradar-userlane] A tradie who finds a flow
annoying doesn't file feedback — **he silently goes back to re-doing it from scratch, or to paper,
and the feature has lost.**

> **Design rule:** the manual fallback (re-do it from scratch / do it on paper) is always
> available to him and always tempting. A feature must be *clearly* less effort than the manual
> way, every time, or he reverts.

### FM-3 — Double data-entry is a dealbreaker

Re-keying data he's already entered is one of the most-hated frictions. The best tools **connect
with what he already uses so he doesn't enter data twice.** [trustedtradie-apps]

> **Design rule:** never make him re-enter anything that already exists in the system. This is the
> core argument for resume-and-edit over "just make a new one."

### FM-4 — Process-tech mismatch compounds inefficiency

You **can't layer software on top of a broken or unfamiliar workflow** and expect it to help — tech
laid over a process that doesn't match how he works **compounds inefficiency rather than fixing
it.** [kylenitchen-2026]

> **Design rule:** the feature must match how he *already thinks* about the task, not impose a new
> ritual he has to learn. Map to his existing mental model (he thinks in jobs, customers, and
> documents — not in databases, records, or versions).

### FM-5 — The capability dip gets the plug pulled

Every new tool creates an initial performance dip while he adjusts. Tradies (and the people
leading small crews) hit that dip, conclude the tool failed, and **retreat to what's comfortable —
paper, spreadsheets, memory.** [kylenitchen-2026]

> **Design rule:** first-use must be obvious and rewarding. No learning curve he has to push
> through. The win has to be immediate or he won't give it a second go.

### FM-6 — If it looks unprofessional to the customer, it's worse than nothing

Because the quote is a trust artifact (§2), a feature that produces a customer-facing output that
looks rushed, inconsistent, or broken actively *costs* him the thing he's paying the software to
protect — his professional image and the deal. [serviceseeking-2026b]

> **Design rule:** customer-facing output quality is non-negotiable. A revised quote must look as
> polished as the original. Never ship a feature that can produce a ragged customer-facing
> artifact.

---

## 4. Persona snapshot (the quick-reference)

| Dimension | Reality |
|-----------|---------|
| **Identity** | Small trade operator, solo or small crew. Rather hold a drill than a laptop. |
| **Tech stance** | Pragmatic, impatient. Software earns its place or gets cut. Smartphone-native, business-software-wary. |
| **Where/when** | Between jobs, after hours, in the ute, kitchen table at 8pm. Phone or tablet. Tired, interruptible. Low cognitive load required. |
| **Home base** | His job-management platform (ServiceM8 for the founding segment). Rafter is a bounce-in tool. |
| **What wins him work** | Speed of response, a quote that looks professional and certain, online reputation. |
| **Biggest pain** | 8–12 hrs/week admin; quoting and chasing payment; losing jobs to faster competitors. |
| **What makes him quit a tool** | Complexity, friction, double-entry, process mismatch, an early dip, unprofessional output. |
| **Money** | Tight cashflow, 44% of invoices late, hard value judgement on every subscription. |

---

## 5. Rafter design principles derived from the persona

These are standing principles for Rafter product decisions, each traceable to the evidence above.

1. **PDF as object ("thingness").** The customer-facing deliverable is a *file*, not a link. A PDF
   has identity in itself — it can be saved, emailed, printed, handed over, opened years later with
   no login or server. It matches how a physical-trade customer thinks and trusts, and it carries
   the professionalism signal (FM-6, §2 trust artifact). Internal system identity (e.g. a quote
   reference) stays internal; it is never forced onto the customer as the thing they hold.
2. **Meet him where he already is.** Rafter bounces off his job-management home base rather than
   trying to become it. Entry points should live where he already works (FM-4).
3. **Fewer steps beat more features.** Every screen and decision is a liability (FM-1).
4. **Never re-key.** Reuse data that already exists; never make him enter it twice (FM-3).
5. **Speed is competitive, not just convenient.** For anything customer-facing, time-to-customer
   can win or lose the job — including revisions (§2).
6. **Polished output, always.** Customer-facing artifacts are never allowed to look ragged (FM-6).
7. **Immediate first win.** No learning curve to push through; the value must land on first use
   (FM-5).

---

## 6. Decision axes — the appraisal lens

When appraising a design option "from the tradie's chair," score it on these axes. They are
derived directly from the failure modes, so they are *his* criteria, not ours.

**Critically: technical cost, build effort, and architectural fit are NOT on this list.** They are
real, but they are *our* problem and belong in a separate pass *after* the persona appraisal. If
an option serves the tradie well but is expensive for us, that is a build problem to solve — not a
reason to mark his experience down. Keep the passes separate or our convenience masquerades as his
benefit.

| Axis | Question | Sourced from |
|------|----------|--------------|
| **A1 — Steps to done** | How few steps from "I need to do this" to "done," under between-jobs/after-hours conditions? | FM-1, FM-5, §1 |
| **A2 — Zero re-entry** | Does he ever re-key anything that already exists? | FM-3 |
| **A3 — Matches mental model** | Does it fit how he already works and thinks, or impose a new ritual? | FM-4 |
| **A4 — Findability when cold** | When the task isn't fresh (days/weeks later), can he get to the right thing with near-zero cognitive load? | FM-1, §1 |
| **A5 — Never confused which is current** | Is he ever unsure which version / item is the real or current one? Confusion erodes trust and triggers retreat. | FM-2, FM-6 |
| **A6 — Customer-facing polish** | If the option produces or affects a customer-facing artifact, is it always polished and consistent? | FM-6, §2 |
| **A7 — Manual-fallback pressure** | Is the option *clearly* less effort than just doing it manually / from scratch? If not, he'll revert. | FM-2 |

Not every axis applies to every decision — note which are in-scope for the option at hand.

---

## 7. How to appraise (method)

To keep the appraisal honest and resistant to internal/technical bias:

1. **Build or load the persona first** (this document) so neither the persona nor the axes can be
   quietly reshaped mid-appraisal to suit a favoured option.
2. **Run each option through concrete scenarios, not abstract criteria.** Friction shows up in the
   walk-through, not in a feature list. Define 3–4 *real* moments the tradie hits, then walk every
   option through every scenario. Concreteness is what resists bias — a real moment either fits how
   he works or it doesn't.
3. **Score only on the persona axes (§6), with technical cost explicitly absent.** Quarantine build
   cost / architecture to a separate later pass.
4. **Call out abandonment triggers.** For each option×scenario, flag where it risks tripping a
   failure mode (§3). An option that's elegant but trips FM-2 or FM-6 is dangerous, not clever.
5. **Then — and only then — a second pass on build cost.** Now ask what each option costs *us* and
   whether the gap from the best-for-tradie option is worth it. This is where "how do we build the
   thing he needs" lives — never "which is easiest for us, dressed up as best for him."

---

## Sources

All gathered June 2026. Refresh before relying on this persona in a later year.

- **[flowtivity-2026]** Flowtivity, "AI for Tradies Australia" (Mar 2026) — industry size (1.2M
  people, $150B), "rather hold a drill than a laptop," runs business on notes/texts/spreadsheets/
  memory, tools must pay for themselves.
- **[undercurrent-2026]** Undercurrent Automations, "How Much Time Australian Tradies Spend on
  Admin" (Mar 2026), citing Xero Small Business Insights 2024 + ABS — 8–12 hrs/week admin,
  $34k–$43k/yr lost time, 44% of invoices paid late.
- **[ayrmont-2025]** Ayrmont ARMS, "Tradesman Quoting Software Guide" (Dec 2025) — quoting happens
  between jobs, after hours, or on the move; on-site/phone quoting; reuse of rates/templates.
- **[serviceseeking-2026a]** ServiceSeeking, "Back to Basics: Professionalism Tips" (May 2026) —
  customers request multiple quotes and pick whoever responds first and sounds reliable; detailed
  quote builds confidence.
- **[serviceseeking-2026b]** ServiceSeeking, "8 Ways Tradies Can Stand Out" (Jan 2026) — customers
  compare how each tradie makes them feel; a clear quote beats a cheaper rushed one.
- **[ottomedia-2026]** Otto Media, "How Fast Tradies Should Respond to Leads" (Mar 2026) — rising
  response-time expectations; slow responders fall behind despite good work; reviews praise
  responsiveness.
- **[servicescale-2026a]** ServiceScale, "Best Job Quoting Software for Tradies 2026" (Mar 2026) —
  ServiceM8 as go-to; tap-to-approve / digital sign / deposit acceptance flow.
- **[servicescale-2026b]** ServiceScale, "Best Quoting Software for Tradies Australia 2026 Guide"
  (~May 2026) — quote-in-inbox-before-you-leave-the-driveway wins jobs; 5–10 hrs/week,
  $600–$1,200/week unbilled.
- **[websitebuilder-2026]** Website Builder Australia, "Marketing for Tradie 2026" (~May 2026),
  citing Hawk Digital — 89% use Google to find local services, 73% check reviews, 52% call the
  first result; modern buyers search/compare/judge before contact.
- **[trustedtradie-apps]** Trusted Tradie Network, "Top Business Management Apps for Tradies in
  Australia" — solo vs crew tool choice; "simple enough to use daily without slowing the job"; tools
  must connect so you don't enter data twice.
- **[trustedtradie-reputation]** Trusted Tradie Network, "Tradie Reputation" — reputation as digital
  word-of-mouth; homeowners read reviews first.
- **[thinkonic-2025]** Thinkonic, "Why MSMEs Resist New Tools: The Hidden Cost of Complexity"
  (2025) — "too many features, confusing"; team stops using it.
- **[techradar-userlane]** TechRadar / Userlane survey — under friction, ~18% of users seek a manual
  workaround and ~10% refuse to keep using the software.
- **[kylenitchen-2026]** The Influential Project Manager, "5 Barriers to Tech Adoption in
  Construction" — process-tech mismatch compounds inefficiency; the capability dip leads to the plug
  being pulled and retreat to paper.

---

*Document version 1.0 — June 2026. Focused first edition: the general Australian tradie. Not yet
segmented by trade or business size — extend deliberately as Rafter learns more about its users.*
