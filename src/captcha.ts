/**
 * CAPTCHA handling: detect it, report it, and stop.
 *
 * Deliberately NOT a solver. Three reasons, and the first is the one that matters:
 *
 *   1. Defeating a bot check on a site you do not own is the behaviour the check exists to
 *      stop. A crawler that ships with one is a crawler that cannot be pointed at anything
 *      in good conscience.
 *   2. It would not work. Image and behavioural challenges are adversarial by design, and a
 *      "mostly works" bypass produces flaky tests and false findings.
 *   3. A QA agent does not need one. What it needs is to know a challenge is there, so it
 *      reports "this flow is gated" instead of "the signup form is broken" - and so it can
 *      tell you when a sensitive form has NO protection at all, which is a real defect this
 *      project previously had no way to express.
 *
 * For a site you DO own, the right route is the provider's own test keys (reCAPTCHA and
 * Turnstile both publish always-pass pairs) wired into your own staging config. That is
 * supported here by `captchaTestMode`, which asserts the challenge is present and expects
 * the flow to proceed - never by this module pretending to answer a challenge.
 */

export type CaptchaKind =
  | "recaptcha-v2"
  | "recaptcha-v3"
  | "hcaptcha"
  | "turnstile"
  | "funcaptcha"
  | "image-captcha"
  | "unknown";

export interface CaptchaSignal {
  kind: CaptchaKind;
  /** What was seen. Short, and safe to put in a report. */
  evidence: string;
  /**
   * Invisible challenges (reCAPTCHA v3, and v2 in invisible mode) score the request
   * silently. They do not block a crawler the way a visible checkbox does, so they are
   * reported differently: worth knowing about, not a reason to stop.
   */
  blocking: boolean;
}

interface Rule {
  kind: CaptchaKind;
  re: RegExp;
  blocking: boolean;
  label: string;
}

/**
 * Matched against page HTML.
 *
 * Script-src and iframe-src patterns are the reliable signals: the vendor's own domain has
 * to appear for the widget to work. Class and data-attribute names are the fallback for a
 * self-hosted or proxied widget.
 */
const RULES: Rule[] = [
  {
    kind: "recaptcha-v3",
    // v3 is identified by the render parameter carrying a site key, not by a widget.
    re: /recaptcha\/api\.js\?[^"']*render=(?!explicit)[A-Za-z0-9_-]{20,}/i,
    blocking: false,
    label: "reCAPTCHA v3 (invisible scoring)",
  },
  {
    kind: "recaptcha-v2",
    // Google's own domain or Google's own class name. NOT a bare data-sitekey: hCaptcha and
    // Turnstile use that attribute too, and keying on it reported every hCaptcha widget as
    // reCAPTCHA. Provider identity is the whole value of this signal - "there is a captcha"
    // is far less useful than "there is an hCaptcha".
    re: /(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\/|g-recaptcha/i,
    blocking: true,
    label: "reCAPTCHA v2",
  },
  {
    kind: "hcaptcha",
    re: /hcaptcha\.com\/1\/api\.js|h-captcha|data-hcaptcha-sitekey/i,
    blocking: true,
    label: "hCaptcha",
  },
  {
    kind: "turnstile",
    re: /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i,
    blocking: true,
    label: "Cloudflare Turnstile",
  },
  {
    kind: "funcaptcha",
    re: /funcaptcha|arkoselabs\.com/i,
    blocking: true,
    label: "Arkose/FunCaptcha",
  },
  {
    kind: "image-captcha",
    // A home-grown challenge: an input asking for the characters in an image.
    re: /<input[^>]+name=["']?(?:captcha|captcha_code|security_code|verification_code|vercode)\b/i,
    blocking: true,
    label: "custom image CAPTCHA field",
  },
  {
    kind: "unknown",
    // A widget we do not recognise by vendor, but a site key is a site key: something here
    // is doing bot verification. Last in the list and only used when nothing specific
    // matched, so a known provider is never reported as "unknown".
    re: /data-sitekey=["'][A-Za-z0-9_-]{8,}/i,
    blocking: true,
    label: "an unrecognised CAPTCHA widget",
  },
];

/** Every challenge visible in this HTML, strongest/most specific rule first. */
export function detectCaptcha(html: string): CaptchaSignal[] {
  const found: CaptchaSignal[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(html);
    if (!m) continue;
    if (found.some((f) => f.kind === rule.kind)) continue;
    // v3 and v2 share the recaptcha domain, so once v3 has matched on its render key the
    // generic v2 rule would double-report the same widget.
    if (rule.kind === "recaptcha-v2" && found.some((f) => f.kind === "recaptcha-v3")) continue;
    // The generic rule is a last resort, never an addition to a named provider.
    if (rule.kind === "unknown" && found.length > 0) continue;
    found.push({
      kind: rule.kind,
      evidence: `${rule.label}: ${m[0].slice(0, 80)}`,
      blocking: rule.blocking,
    });
  }
  return found;
}

/** Does anything here actually stop an automated flow? */
export function isBlocked(signals: CaptchaSignal[]): boolean {
  return signals.some((s) => s.blocking);
}

/**
 * Forms where the ABSENCE of bot protection is itself worth reporting.
 *
 * Not every form needs a CAPTCHA - a search box certainly does not, and demanding one
 * everywhere is how a check gets ignored. These are the ones that cost real money or real
 * inboxes when automated: account creation, password reset, anything that sends mail, and
 * anything that takes a payment.
 */
const SENSITIVE = [
  { re: /sign[\s_-]?up|register|create[\s_-]?account/i, what: "account creation" },
  { re: /forgot[\s_-]?password|reset[\s_-]?password|password[\s_-]?reset/i, what: "password reset" },
  { re: /contact|feedback|enquir|support[\s_-]?ticket/i, what: "a message-sending form" },
  { re: /subscribe|newsletter/i, what: "a subscription form" },
  { re: /checkout|payment|billing/i, what: "a payment form" },
];

export interface UnprotectedForm {
  what: string;
  /** The signal that identified the form - an action path or a field name. */
  matched: string;
}

/**
 * A sensitive form with no bot protection on its page.
 *
 * Takes the form's identifying strings (action and field names) plus whatever CAPTCHA
 * signals the page carries, because protection is page-level in practice: the widget sits
 * next to the form, not inside its action attribute.
 */
export function unprotectedSensitiveForm(
  identifiers: string[],
  pageSignals: CaptchaSignal[],
): UnprotectedForm | null {
  if (pageSignals.length > 0) return null;
  const haystack = identifiers.filter(Boolean).join(" ");
  if (!haystack.trim()) return null;

  for (const s of SENSITIVE) {
    const m = s.re.exec(haystack);
    if (m) return { what: s.what, matched: m[0] };
  }
  return null;
}
