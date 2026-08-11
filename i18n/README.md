# ProCraft Dealer Portal — i18n (DOC-1)

> **This is DOC-1.** Read this before editing anything in `i18n/` or in
> `components/i18n.js`, `components/lang-switch.js`, `components/login-i18n-bridge.js`.
>
> Introduced by **CB-62 Stage A**. Version tag: `cb62`.

---

## 1. Scope — what is and is not translated

| Translated | Not translated (ever) |
| --- | --- |
| Dealer-facing interface text | `admin.html` / `admin-*.html` — internal, English only |
| Static labels, buttons, headings | DB-sourced data (product names, SKUs, descriptions) |
| Runtime messages (errors, status) | Emails (Brevo templates) |
| `<title>`, `aria-label`, `placeholder` | PDFs (`pdf-builder.js`) |
| | Brand names: `ProCraft Cabinetry · DC`, `ProCraft DC` |
| | `quotes.status` DB values (see §7) |

Language preference lives in **`localStorage` only**. It is never written to the DB.

**Supported languages:** `en` (base), `es`.
Planned: `zh` (Simplified Chinese) — see §5.

---

## 2. Golden rules

1. **i18n changes text, never structure.** Everything is written via `textContent`
   or a named attribute. There is no `innerHTML` path anywhere in the framework.
   This is deliberate — it keeps the XSS surface at zero. If a string needs inline
   markup (bold, italic, a link), **split it into multiple keys and keep the markup
   in the HTML** — do not invent an HTML-injecting attribute.
   *Precedent: `login.brand.tagline_1` + `login.brand.tagline_2` wrap a `<em>`.*

2. **`en.json` is the fallback source of truth.** Every key must exist in `en.json`.
   Other language files may lag behind; that is safe (see §3).

3. **Never use an absolute path to load a language file.** See §6.

4. **Never build display strings by concatenation.** `'Updated to ' + status` cannot
   be translated. Use a parameter: `pcT('quote.msg.updated', { status: x })`.

5. **Bumping a language file requires bumping two `?v=` values.** See §4.

---

## 3. Fallback chain — three layers

```
current language  →  en.json  →  leave the HTML text untouched
```

The third layer is the important one. When a key is missing from **both** files,
the framework **does not write anything** and the original English text authored in
the HTML stays on screen.

Consequences, which are the whole point:

- A raw key (`login.title`) can never appear on screen.
- A blank label can never appear on screen.
- English users get zero FOUC — hydration is a no-op for them.
- A new language can ship **partially translated** without breaking any layout.

> When adding `zh.json`, it is perfectly acceptable to translate 60% of the keys and
> ship. The untranslated 40% will render in English, not as holes.

---

## 4. 🔴 Cache rule — TWO `?v=` values must be bumped together

This is the F-24 / B-7 trap, restated for i18n.

There are two independent cache surfaces:

| Surface | Where the version lives | Who edits it |
| --- | --- | --- |
| The framework script | `<script src="components/i18n.js?v=cb62">` in **each HTML page** | a human, by hand |
| The language files | `PC_I18N_VER` constant **inside `components/i18n.js`** | a human, by hand |

`i18n.js` fetches `i18n/<lang>.json?v=<PC_I18N_VER>`.

**The failure mode:** you edit `es.json` and bump only `PC_I18N_VER`. Browsers still
hold the old `i18n.js` (its `<script src>` URL did not change), so they never see the
new constant, so they keep requesting the old language-file URL. **Your edit is
invisible and nothing looks broken** — the worst kind of bug.

**The rule:**

> Any change to any file in `i18n/` requires bumping **both**
> `PC_I18N_VER` inside `components/i18n.js` **and** the `?v=` on every
> `<script src="components/i18n.js?v=…">` across all pages.

Keep the two values identical. Suggested scheme: the ticket that made the change
(`cb62`, then `cb63`, `cb63a`, …).

### 🔴 When to bump: once, immediately before promoting

Bumping per work package would mean editing every i18n-loading page several times
over — including `login.html`, whose auth script is frozen and re-hashed on every
touch. So:

> **Do not bump `?v=` while iterating on `staging`. Bump every page once,
> immediately before promoting to `main`.**

This rests on one hard rule, which is not optional:

> **🔴 All staging testing happens in a private window.** That is what makes a
> deferred bump safe. A normal window will serve you a stale HTML file and you will
> chase a bug that does not exist.
>
> This is not hypothetical — it happened during CB-62 B3. A page appeared to show
> two language switches; the file on disk had one. HTML files carry no `?v=` of
> their own, so the browser had cached the previous version of the page against an
> already-updated component.

Before promoting, walk a written checklist of **every** page that loads `i18n.js`,
plus the pages listed under "Shared components are live files" below. Missing one
page leaves it requesting a stale language file with no visible symptom.

**Verification:** open the page in a private window, DevTools → Network, confirm the
request for `i18n/es.json?v=<new>` returns 200 and the response body contains the edit.

### 🔴 Shared components are live files — content ships without a bump

`?v=` controls **caching**, not what the server sends. A page requesting
`components/navigator.js?v=1.0` still receives whatever is in the repo right now.

So editing a shared component takes effect **the moment it is committed**, for every
page that loads it and for every visitor with a cold cache. The `?v=` bump only
forces warm caches to catch up sooner.

Two things follow:

- **Do not read "no bump yet" as "not live yet."** A component change is testable in
  a private window immediately, and it is already reaching real users.
- **Regression-test the moment you commit it, not at the end of the work package.**
  `navigator.js` and `footer.js` load on 12 pages, six of them admin;
  `feedback-widget.js` on 10; `status-label.js` on five. A mistake in any of them is
  live before you have finished the rest of your files.

Pages loading each shared component, for the pre-promote checklist:

| Component | Pages |
| --- | --- |
| `navigator.js`, `footer.js` | dashboard, quotes, quote-detail, dealer-profile, change-password, payment, admin, admin-quotes, admin-payments, admin-dealers, admin-accounts, admin-tags |
| `feedback-widget.js` | the above minus change-password, payment, admin-tags |
| `status-label.js` | dashboard, quotes, quote-detail, admin, admin-quotes |
| `quote-flow-header.js` | new-quote, new-quote-modifications, new-quote-step2, new-quote-step3 |

---

## 5. Adding a new language

The framework does not change. Four steps:

1. **Copy `en.json` to `i18n/<code>.json`** and translate the values.
   Keep the keys and their order identical — it makes review diffs readable.
   Partial translation is safe (§3).
2. **Add the language to the list in `components/lang-switch.js`.**
   It is a single array of `{ code, label }`. This is the only code change.
3. **Add the language to the whitelist in `components/i18n.js`.**
   The whitelist exists so that a hand-edited `localStorage` value cannot make the
   page request a nonexistent file.
4. **Add a `html[lang="<code>"]` CSS block** to any page whose layout needs it (§8).

Then bump both `?v=` values (§4) and test per §9.

### Note for `zh` (Simplified Chinese)

Simplified Chinese is planned for dealer-facing pages. Traditional Chinese is used
for internal project communication and must **not** be used in language files.
Chinese text is typically **30–40% shorter** than English, which is the opposite
problem from Spanish — expect labels to look sparse rather than cramped, and check
that fixed-width elements do not look empty.

---

## 6. 🔴 Path rule — relative only, resolved at runtime

Language files are fetched as:

```js
new URL('i18n/' + lang + '.json?v=' + PC_I18N_VER, document.baseURI)
```

**Never write `/i18n/en.json`.** The leading slash is the bug.

Why: as documented in the CB-53 / B-14 comment inside `login.html`, this app is not
guaranteed to sit at the domain root. Staging has been served from a subdirectory,
and `procraftben.github.io` is a shared origin across every repo on the account. An
absolute path resolves against the origin root and 404s under any subdirectory
deployment. Runtime derivation from `document.baseURI` is correct in every case.

The same reasoning applies to the `<script src>` values: keep them relative
(`components/i18n.js?v=cb62`), never rooted.

---

## 7. 🔴 Coupling — `login-i18n-bridge.js` and the `login.html` auth script

**Read this before editing any user-facing string inside `login.html`.**

### Why the Bridge exists

`login.html`'s inline `<script>` (L315–718) contains the auth, password-reset,
redirect (CB-53) and reCAPTCHA (CB-42) logic. That block is **frozen** — it is
verified byte-identical on every delivery via SHA-256, exactly as F-20 did.

Eleven user-facing strings live inside that frozen block. Rather than edit them,
`components/login-i18n-bridge.js` attaches a `MutationObserver` to the three DOM
nodes those strings are written to, and rewrites the text after the fact.

This was chosen over editing the auth script because it keeps the freeze genuine.
It works because **every** user-visible string in that block is written via
`textContent` — there is no `innerHTML` and no other path. Verified at CB-62 Stage 1.

### Observed nodes

| Node | Written by |
| --- | --- |
| `#errorMsg` | `showError()` |
| `#infoMsg` | `showInfo()` |
| `#loginBtn` | `setBusy()` and two direct assignments |

### 🔴 The coupled literals

The Bridge maps **exact English source strings** to keys. The table below is the
state as of CB-62 Stage A. Line numbers refer to `login.html` at
`sha256 0e3fded73e430c83f89149381586ceff6d72f13ade1f43a4efd6b8ecd2c4570a`.

| Key | English literal | `login.html` lines |
| --- | --- | --- |
| `login.busy.verifying` | `Verifying...` | L621, L694 |
| `login.busy.signing_in` | `Signing in...` | L631 |
| `login.busy.sending` | `Sending...` | L703 |
| `login.btn.sign_in` | `Sign In` | L544, L658, L715 |
| `login.err.missing_credentials` | `Please enter your email and password.` | L616 |
| `login.err.verification_failed` | `Verification failed. Please refresh the page and try again.` | L627, L699 |
| `login.err.invalid_credentials` | `Invalid email or password. Please try again.` | L636 |
| `login.err.account_deactivated` | `Your account has been deactivated. Please contact ProCraft DC.` | L648 |
| `login.err.unexpected` | `Something went wrong. Please try again.` | L656, L713 |
| `login.err.email_required` | `Please enter your email address first.` | L689 |
| `login.info.reset_sent` | `If this email is registered, a reset link has been sent. Please check your inbox.` | L709 |

### 🔴 If you change one of these English strings

**You must update the reverse map in `components/login-i18n-bridge.js` in the same
change, and update this table.**

If you do not: the Bridge stops recognising the string, **does not overwrite it**,
and the user sees English. Nothing crashes and no layout breaks — the failure is
fail-safe by design — but Spanish speakers silently lose that message. The Bridge
logs a `console.warn` naming the unmatched string; that warning is the only signal.

The match is **exact and literal**. A trailing space, a changed ellipsis, or
`e-mail` instead of `email` all count as a miss.

### If the auth script freeze is ever lifted

The Bridge becomes unnecessary. Replace the eleven literals with `pcT()` calls
directly and delete `components/login-i18n-bridge.js`. Do not do this while the
byte-identical requirement is in force.

---

## 8. 🔴 Language-specific CSS

When a translation does not fit the layout, **do not change the shared rule**.
Override it under a language attribute selector:

```css
html[lang="es"] .brand-line { max-width: 16ch; font-size: 34px; }
```

`components/i18n.js` sets `document.documentElement.lang` on load and on every
language switch, so these blocks activate automatically.

Why this matters: the English rendering path never touches these rules, so English
output stays byte-identical. Adding Simplified Chinese later means adding an
`html[lang="zh"]` block, not renegotiating the shared stylesheet.

Expect Spanish to run **20–30% longer** than English. Watch full-width buttons with
`text-transform: uppercase` and wide `letter-spacing` — that combination is where
things break first.

---

## 9. API reference

Load order on every page:

```
supabase CDN
config.js
components/status-label.js?v=…      (only on pages that render quote status)
components/i18n.js?v=cb62
components/lang-switch.js?v=cb62
… page inline script …
```

Both files are plain synchronous `<script src>` — no `defer`, no `async` — so
`window.pcT` is guaranteed to exist when the page's inline script runs.

### Functions

| Name | Purpose |
| --- | --- |
| `pcT(key, params)` | **Canonical.** Returns the translated string. Three-layer fallback (§3). |
| `t(key, params)` | Convenience alias. See the warning below. |
| `pcSetLang(lang)` | Persist, re-hydrate, fire the event. |
| `pcGetLang()` | Current language code. |
| `pcApplyI18n(root)` | Hydrate a subtree. Idempotent; safe to call repeatedly. |
| `PC_I18N_READY` | Promise. Resolves when language files have loaded **or failed**. Never rejects. |

### ⚠️ Use `pcT`, not `t`, in page code

`t` is a one-character global. If any page's inline script declares `const t` at top
level, that declaration shadows the alias and every `t()` call on that page breaks.

This is the same class of bug documented in `components/status-label.js` (the
`statusLabel` collision that would have killed all JS on five pages). The framework
is wrapped in an IIFE and assigns to `window`, so a collision cannot produce a
`SyntaxError` — the worst case is one page losing translations. Still, **Stage B
pages should call `pcT()`**. The `t` alias exists for brevity in one-off snippets.

### Shadow DOM

`pcApplyI18n(root)` takes any node with `querySelectorAll` — including a
`ShadowRoot`. `components/feedback-widget.js` needs this: its UI lives in a
**closed** shadow root, so `i18n.js`'s own `document.querySelectorAll` sweep cannot
see it. The component marks up its own DOM and calls `pcApplyI18n(_shadow)` after
mounting and again on `pc:i18n-changed`.

**Re-hydrate, never rebuild.** That widget holds a half-typed message and the user's
chosen sentiment and category. Rebuilding the modal would wipe all three. The same
caution applies anywhere a component owns user input.

### Mounting the language switch

`components/lang-switch.js` exposes `pcMountLangSwitch(container, { inline: true })`
for containers that appear **after** `DOMContentLoaded`. `navigator.js` uses it: the
navbar cannot render until session and role have been fetched, by which point the
automatic `#pcd-lang-switch` sweep has long since run.

The function returns `null` and renders nothing when `i18n.js` is absent (admin
pages), when the container is missing, or when the container already has content.
Multiple instances are supported and stay in sync — the navbar and the mobile menu
each get one.

Pages that load `navigator.js` should **not** carry their own `#pcd-lang-switch`
div; the navbar supplies the switch. The standalone div remains supported for pages
without a navbar.

### Markup attributes

| Attribute | Target |
| --- | --- |
| `data-i18n="key"` | `textContent` |
| `data-i18n-placeholder="key"` | `placeholder` |
| `data-i18n-title="key"` | `title` |
| `data-i18n-aria-label="key"` | `aria-label` |

**Always author the correct English text in the HTML as well.** It is the third
fallback layer and it is what English users actually see (hydration is a no-op).

### Event

```js
document.addEventListener('pc:i18n-changed', function (e) {
  // e.detail.lang — re-render anything the framework cannot reach,
  // e.g. text inside JS-generated tables or charts
});
```

### Parameters

```js
pcT('login.footer.copyright', { year: new Date().getFullYear() });
```

Placeholders are `{name}`. An unsupplied placeholder is left in the string verbatim
rather than throwing or rendering `undefined`.

### Failure behaviour

If a language file 404s, times out, or fails to parse, the framework **writes
nothing**, logs via `console.error`, and resolves `PC_I18N_READY` anyway. The page
renders in the English authored in the HTML and remains fully functional.

This mirrors the CB-42 fail-open policy: an i18n outage must never be able to
prevent a dealer from logging in.

`localStorage` access is wrapped in `try/catch` throughout. Private browsing or
disabled storage degrades to an in-memory preference for the session; it never
throws.

---

## 10. Key naming

```
<module>.<type>.<name>
```

**Modules:** `common`, `login`, `nav`, `dashboard`, `quote`, `payment`, `profile`, `status`

**Types:** `title`, `subtitle`, `btn`, `field`, `err`, `info`, `busy`, `meta`, `brand`

Lowercase, dot-separated, underscores within a segment. Enforced by review, not by
code. Approved at CB-62 Stage 0 (Q-5) as the basis for all Stage B pages —
**do not renegotiate the structure per page.**

### 🔴 `status.*` — owned by `status-label.js`, not by `i18n.js`

Resolved at CB-62 Stage B / B1 (Q-8). Read this before touching anything status-related.

`components/status-label.js` maps `quotes.status` **DB values** to display names. The
DB values drive F2 triggers, n8n filters and RLS and must never change; only the
display name is translated.

**The switch is whether `i18n.js` is loaded on the page.**

| Page | Loads `i18n.js`? | `status-label.js` behaviour |
| --- | --- | --- |
| `admin.html`, `admin-quotes.html` | no | identical to pre-i18n — English, always |
| dealer pages | yes | looks up `status.*`, falls back to English |

Admin pages need no flag, no role check, no blocklist. They simply don't load
`i18n.js`, so `window.pcT` is undefined and the lookup is skipped. This is why
`status-label.js` does **not** retire: it is simultaneously the single source of truth
for admin and the English fallback layer for dealers.

**Lookup chain:** `status.<label|short>.<slug>` → the `LABEL` / `SHORT` map inside
`status-label.js` → the raw DB value (for labels) or *skip* (for short forms).

**Keys.** Nine labels, two short forms:

```
status.label.draft  stock_review  pending  returned  payment_processing
             order_processing  order_completed  closed  cancelled
status.short.pending  returned
```

DB value → slug goes through an explicit map in `status-label.js`. Do not derive
slugs by transforming the string — a future status value would silently produce the
wrong key.

**🔴 `status.short.*` holds exactly two keys, and that is deliberate.** Short forms
are for narrow stat cards. If a key is missing there, `status-label.js` **skips the
node** rather than falling back to the full label — writing "Payment Processing" into
a card sized for "Waiting" breaks the layout. Never add a `status.short.*` key just
because a label exists.

**🔴 Two English strings are duplicated on purpose.** `status.label.pending` /
`status.label.returned` in `en.json` repeat the `LABEL` map inside
`status-label.js`. The map is what admin pages use, and admin must never depend on
the i18n layer. Same coupling pattern as the login Bridge (§7): **change one, change
the other.** The other seven statuses exist only in `en.json`; on admin pages they
fall through to the raw DB value, which is exactly what they render today.

### 🔴 Who owns which node — one owner per node

| Content | Owner | On language change |
| --- | --- | --- |
| `data-pc-status-label` / `-short` | `status-label.js` | re-hydrates itself |
| `data-i18n` and friends | `i18n.js` | re-hydrates itself |
| **Anything rendered by page JS** | **the page** | **the page must re-render** |

The third row is the only per-page work in Stage B. Pattern: keep the fetched data in
a module-scope variable, extract rendering into a function, and call it again from a
`pc:i18n-changed` listener. `dashboard.html` is the reference implementation.

**Never put `data-i18n` and `data-pc-status-*` on the same element.** Two hydrators
would overwrite each other and the winner would depend on load order.

### 🔴 Shared components — the switch is still "is i18n.js loaded"

`navigator.js`, `footer.js` and `feedback-widget.js` each carry English strings and
look up translations only when `window.pcT` exists. Admin pages never load
`i18n.js`, so they render exactly what they rendered before CB-62 — no flag, no role
check, no blocklist. Verified for all three by diffing admin output against dealer
English output.

Two consequences worth stating plainly:

- **`ADMIN_NAV` in `navigator.js` deliberately has no `key` fields.** The admin menu
  is never translated, not even through a fallback. Only `DEALER_NAV` carries keys.
- **`page` and `href` are internal identifiers.** Only `label` is display text.
  Translating a menu item must never touch routing.

### 🔴 Duplicated English strings — the running list

Some English text is written twice on purpose: once in a component (which admin
pages and the offline fallback path use) and once in `en.json` (which dealer pages
use). **Change one, change the other.** No test catches this; only this list does.

| Component | Strings | `en.json` keys |
| --- | --- | --- |
| `status-label.js` | `LABEL` map: Pending, Returned | `status.label.pending`, `status.label.returned` |
| `footer.js` | `FOOTER_CONTENT.copyright`, `.contactText` | `footer.copyright`, `footer.contact` |
| `feedback-widget.js` | `SENTIMENTS[].label`, `CATEGORIES[].label` | `feedback.sentiment.*`, `feedback.category.*` |
| `navigator.js` | `DEALER_NAV[].label` and every `t(key, 'English')` fallback | `nav.*` |
| `login.html` (frozen) | 11 auth-script literals | see §7 |

The pattern is always the same: the second argument to `t()` **is** the English
string. If you edit one, grep the other file for it.

---

## 11. Working notes

### GitHub web UI — branch and path

Two separate traps, both hit during CB-62 Stage 2.

**Branch.** Creating a file via **Add file → Create new file** resets the target
branch to the repo default (`main`), **even if you had switched to `staging`
beforehand**. The branch shown in the header is not what gets committed.

- Use the direct URL: `…/new/staging` for a new file, `…/edit/staging/<path>` for an edit.
- **Then confirm the radio button at the bottom of the page** reads
  *Commit directly to the `staging` branch*. That control is the only reliable one.

**Path.** The filename field remembers the directory of the file you created last
and shows it as a grey breadcrumb to the left of the input. Typing a bare
`i18n.js` after having just created something under `i18n/` produces
`i18n/i18n.js`, not `components/i18n.js`.

- Always type the **full path** including the directory: `components/i18n.js`.
- Check the grey breadcrumb before committing. Backspace clears it back to the repo root.

Both slips landed on inert, unreferenced files and were harmless. The same slip on
an HTML file would push untested code to production.

### 🔴 GitHub Pages — deployment is two-stage and serialised

**The main repo's Action turning green does not mean the site is live.**

Deployment runs in two stages:

1. `Deploy staging to staging-repo` in **`procraft-dealer-portal`** — copies files
   into the deployment repo. This is the green tick you see first.
2. `pages build and deployment` in the **deployment repo** — actually publishes.

Only the second one puts bytes in front of a browser. Before testing anything,
check the *deployment repo's* Actions tab, not the main repo's.

**Pages runs one deployment at a time.** A push that arrives while another
deployment is still open is rejected with:

```
HttpError: Deployment request failed for <sha> due to in progress deployment.
Please cancel <sha> first or wait for it to complete.
```

Worse, the failed deployment can stay flagged **Active** in the Deployments tab,
holding the lock indefinitely. During CB-62 Stage 2 this blocked publishing for over
30 minutes, and **Cancel workflow returned "Failed to cancel workflow"** — the
Actions layer could not clear it.

**What works:** Settings → Pages → set the source branch to **None** → Save → wait
30 seconds → set it back to **`gh-pages`** / **`/ (root)`** → Save. This releases the
lock and triggers a clean rebuild. Do this on the **deployment repo only** — the main
repo's Pages settings serve production.

Do *not* try to fix a stuck deployment by pushing again. Another push just queues
behind the same lock and makes the backlog longer.

**Prevention:** batch related edits into fewer commits, and space pushes out. Seven
pushes in 35 minutes is what triggered it. This matters most for Stage B, which will
touch 20+ pages.

### Promoting to `main`

Copy files **individually**. Never `git merge` between `staging` and `main`:
`config.js` differs between branches (staging carries a placeholder n8n webhook URL)
and a merge will clobber it.

Promote inert files (language files, components) **before** the HTML that references
them. Until an HTML file loads them, the support files change nothing — which means
the whole promote can be staged safely and rolled back by reverting one HTML file.

### 🔴 Two recurring mistakes

**Re-render guards written too tightly.** The pattern is always the same: a
`pc:i18n-changed` handler adds a condition to avoid unnecessary work, and that
condition turns out to be false in exactly the case that needed re-rendering.

Real examples from CB-62:

- `if (passwordField.value) checkStrength()` — the strength label stayed in the old
  language whenever the field was empty, because the function that clears it never ran.
- `if (!quotes.length) return` — the *empty state* text stayed in the old language,
  since zero quotes is precisely when that text is on screen.

Guard on **"has this ever loaded?"**, not on **"is there data right now?"**.

**Arrays that feed both display and data.** `dealer-profile.html` builds its
`business_hours` object keys from the same array it renders day names from
(`day.toLowerCase()`). Translating that array would have written `lunes` as a
database key and pushed it to the public Dealer Locator.

Before translating any array, ask what else reads it. If the answer is anything
other than "the screen", split display from data first. Where the two are already
separate fields — like `{ value, label }` in the feedback widget — only `label` is
ever translated.

### Delivery checklist for i18n changes

- [ ] `en.json` and `es.json` have identical key sets, in identical order
- [ ] No key has an empty value
- [ ] `{param}` placeholders match across all languages for a given key
- [ ] Re-render guards checked against the empty case (§11)
- [ ] Any duplicated English string updated in **both** places (§10)
- [ ] Tested in a **private window** (§4)
- [ ] `PC_I18N_VER` and every page's `?v=` — **at promote time only** (§4)
- [ ] §7 table updated if any `login.html` English string changed
- [ ] Private-window load confirms the new language file is served

---

## 12. Spanish terminology (glossary)

Fixed at CB-62 Stage B / B1 (Q-15). Reuse these across every page. Consistency
matters more than any individual word choice — a dealer who sees *cotización* on one
screen and *presupuesto* on the next assumes they are different things.

| English | Spanish | Note |
| --- | --- | --- |
| Quote / Estimate | **Cotización** | Deliberately one word for both |
| Draft | Borrador | |
| Order | Pedido | |
| Dealer | Distribuidor | |
| Payment | Pago | |
| Invoice | Factura | |
| Receipt | Recibo | |
| Discount | Descuento | |
| Stock | Inventario | |
| Shipping | Envío | |
| Job Name | Nombre del proyecto | The project a quote belongs to |
| **PO #** | *not translated* | Appears on PDFs, which stay English |
| **SKU** | *not translated* | Same reason |

**On Quote vs Estimate.** The English UI uses both for the same object — the button
reads "New Estimate" but everything downstream says "quote". Spanish collapses them
into *cotización* rather than reproducing the inconsistency. If the English wording is
ever unified, no Spanish key needs to change.

**Register.** Formal *usted* throughout, matching the B2B dealer context. Never *tú*.

**Not translated anywhere:** brand names (`ProCraft Cabinetry · DC`, `ProCraft DC`),
DB-sourced data (product names, SKUs, descriptions), and `quotes.status` DB values —
only their display names are translated (§10).
