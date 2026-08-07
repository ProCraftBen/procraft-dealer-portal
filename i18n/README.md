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

**Verification:** open the page in a private window, DevTools → Network, confirm the
request for `i18n/es.json?v=<new>` returns 200 and the response body contains the edit.

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

### 🔴 Reserved: `status.*`

`components/status-label.js` is the single source of truth for `quotes.status`
display names, and it is deliberately decoupled from the DB values (which drive F2
triggers, n8n filters and RLS, and must never change).

`status.*` keys are **reserved but unused**. Do not add them ad hoc. Reconciling
`status-label.js` with the i18n layer is the **first item of Stage B**, and it needs
a decision on which file owns the display string.

---

## 11. Working notes

### GitHub web UI — branch selection

Creating a file via **Add file → Create new file** resets the target branch to the
repo default (`main`), **even if you had switched to `staging` beforehand**. The
branch shown in the header is not what gets committed.

- Use the direct URL: `…/new/staging` for a new file, `…/edit/staging/<path>` for an edit.
- **Then confirm the radio button at the bottom of the page** reads
  *Commit directly to the `staging` branch*. That control is the only reliable one.

This happened during CB-62 Stage 2 (both language files landed on `main`). Harmless
that time — the files were inert and unreferenced — but the same slip on an HTML
file would push untested code to production.

### Promoting to `main`

Copy files **individually**. Never `git merge` between `staging` and `main`:
`config.js` differs between branches (staging carries a placeholder n8n webhook URL)
and a merge will clobber it.

### Delivery checklist for i18n changes

- [ ] `en.json` and `es.json` have identical key sets, in identical order
- [ ] No key has an empty value
- [ ] `{param}` placeholders match across all languages for a given key
- [ ] `PC_I18N_VER` bumped
- [ ] `?v=` bumped on every `<script src="components/i18n.js…">`
- [ ] §7 table updated if any `login.html` English string changed
- [ ] Private-window load confirms the new language file is served
