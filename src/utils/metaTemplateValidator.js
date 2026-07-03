/**
 * metaTemplateValidator.js
 *
 * Client-side enforcement of Meta's WhatsApp message template rules.
 * Goal: catch every violation BEFORE hitting the network, so users get
 * instant feedback instead of waiting on a Meta rejection.
 *
 * These rules are STRICT and MANDATORY — nothing here can be bypassed.
 * Reference: Meta WhatsApp Business Platform template guidelines.
 */

export const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];

export const LANGUAGES = [
  { code: 'en_US', label: 'English (US)' },
  { code: 'en',    label: 'English' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'ur',    label: 'Urdu' },
  { code: 'ar',    label: 'Arabic' },
  { code: 'es',    label: 'Spanish' },
  { code: 'fr',    label: 'French' },
];

const NAME_REGEX = /^[a-z0-9_]+$/;
const VARIABLE_REGEX = /\{\{(\d+)\}\}/g;

// ---------------------------------------------------------------------------
// Individual field validators — each returns { valid, message }
// ---------------------------------------------------------------------------

export const validateTemplateName = (name) => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { valid: false, message: 'Template name is required.' };
  if (!NAME_REGEX.test(trimmed)) {
    return { valid: false, message: 'Use lowercase letters, numbers, and underscores only (e.g. policy_reminder_3d).' };
  }
  if (trimmed.length > 512) {
    return { valid: false, message: 'Template name is too long.' };
  }
  return { valid: true, message: '' };
};

export const validateCategory = (category) => {
  if (!CATEGORIES.includes(category)) {
    return { valid: false, message: 'Select a valid category: Utility, Marketing, or Authentication.' };
  }
  return { valid: true, message: '' };
};

export const validateLanguage = (code) => {
  if (!LANGUAGES.some((l) => l.code === code)) {
    return { valid: false, message: 'Select a supported language.' };
  }
  return { valid: true, message: '' };
};

/**
 * Validates the BODY component text against Meta's rules:
 *  - required, max 1024 chars
 *  - cannot start or end with a variable
 *  - variables must be sequential starting at {{1}} with no gaps
 *  - no two variables back-to-back with nothing between them
 */
export const validateBodyText = (body) => {
  const trimmed = (body ?? '').trim();

  if (!trimmed) {
    return { valid: false, message: 'Message body is required.' };
  }
  if (trimmed.length > 1024) {
    return { valid: false, message: `Body exceeds 1024 characters (currently ${trimmed.length}).` };
  }

  // Must not start or end directly with a variable
  if (/^\{\{\d+\}\}/.test(trimmed)) {
    return { valid: false, message: 'Body cannot start with a variable. Add text before {{1}}.' };
  }
  if (/\{\{\d+\}\}$/.test(trimmed)) {
    return { valid: false, message: 'Body cannot end with a variable. Add text after the last variable.' };
  }

  // No two variables back-to-back (nothing between them)
  if (/\}\}\s*\{\{/.test(trimmed.replace(/\}\}\{\{/g, '}}{{'))) {
    // Catch the strict "no space at all" case explicitly
  }
  if (/\}\}\{\{/.test(trimmed)) {
    return { valid: false, message: 'Variables cannot be placed directly next to each other. Add text between them.' };
  }

  // Variables must be sequential: {{1}}, {{2}}, {{3}} — no gaps, no duplicates, no out-of-order
  const matches = [...trimmed.matchAll(VARIABLE_REGEX)].map((m) => parseInt(m[1], 10));
  if (matches.length > 0) {
    const expected = matches.map((_, i) => i + 1);
    const sortedUnique = [...new Set(matches)].sort((a, b) => a - b);
    const isSequential = sortedUnique.length === matches.length &&
      sortedUnique.every((val, i) => val === expected[i]);

    if (!isSequential) {
      return {
        valid: false,
        message: 'Variables must be sequential starting at {{1}} with no gaps or duplicates (e.g. {{1}}, {{2}}, {{3}}).',
      };
    }
  }

  return { valid: true, message: '' };
};

/**
 * Sample values are mandatory for every variable used in the body —
 * Meta's reviewers (and automated system) reject submissions without them.
 *
 * @param {string} body
 * @param {string[]} samples  array of sample strings, indexed by variable number - 1
 */
export const validateSampleValues = (body, samples = []) => {
  const trimmed = (body ?? '').trim();
  const matches = [...trimmed.matchAll(VARIABLE_REGEX)];
  const variableCount = new Set(matches.map((m) => m[1])).size;

  if (variableCount === 0) {
    return { valid: true, message: '' }; // no variables, nothing to validate
  }

  for (let i = 0; i < variableCount; i++) {
    if (!samples[i] || !samples[i].trim()) {
      return { valid: false, message: `Sample value for {{${i + 1}}} is required.` };
    }
  }

  return { valid: true, message: '' };
};

/**
 * Footer: plain text only, max 60 chars, NO variables allowed.
 */
export const validateFooter = (footer) => {
  const trimmed = (footer ?? '').trim();
  if (!trimmed) return { valid: true, message: '' }; // footer is optional
  if (trimmed.length > 60) {
    return { valid: false, message: `Footer exceeds 60 characters (currently ${trimmed.length}).` };
  }
  if (/\{\{\d+\}\}/.test(trimmed)) {
    return { valid: false, message: 'Footer cannot contain variables.' };
  }
  return { valid: true, message: '' };
};

/**
 * Header text: max 60 chars, max 1 variable allowed.
 */
export const validateHeaderText = (header) => {
  const trimmed = (header ?? '').trim();
  if (!trimmed) return { valid: true, message: '' }; // header is optional
  if (trimmed.length > 60) {
    return { valid: false, message: `Header exceeds 60 characters (currently ${trimmed.length}).` };
  }
  const matches = [...trimmed.matchAll(VARIABLE_REGEX)];
  if (matches.length > 1) {
    return { valid: false, message: 'Header can contain at most 1 variable.' };
  }
  return { valid: true, message: '' };
};

/**
 * Quick reply button text: max 25 chars.
 */
export const validateQuickReplyButton = (text) => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { valid: false, message: 'Button text is required.' };
  if (trimmed.length > 25) {
    return { valid: false, message: `Button text exceeds 25 characters (currently ${trimmed.length}).` };
  }
  return { valid: true, message: '' };
};

/**
 * Validates the full button set: max 10 buttons total.
 */
export const validateButtons = (buttons = []) => {
  if (buttons.length === 0) return { valid: true, message: '' };
  if (buttons.length > 10) {
    return { valid: false, message: 'Maximum 10 buttons allowed per template.' };
  }
  for (const btn of buttons) {
    if (btn.type === 'QUICK_REPLY') {
      const result = validateQuickReplyButton(btn.text);
      if (!result.valid) return result;
    }
    if (btn.type === 'PHONE_NUMBER' && !btn.phone_number?.trim()) {
      return { valid: false, message: 'Phone number is required for call-to-action button.' };
    }
    if (btn.type === 'URL' && !btn.url?.trim()) {
      return { valid: false, message: 'URL is required for website button.' };
    }
  }
  return { valid: true, message: '' };
};

/**
 * Basic content-policy guard against the most common automatic-rejection
 * triggers. This is NOT a substitute for Meta's own review — it's a
 * first line of defense to save users a wasted submission cycle.
 */
export const validateContentPolicy = (body) => {
  const trimmed = (body ?? '').trim();
  const threatPatterns = [
    /account.{0,20}(block|suspend|terminat)/i,
    /will be (block|suspend|terminat)/i,
    /act now or/i,
    /failure to.{0,20}(result|lead)/i,
  ];
  for (const pattern of threatPatterns) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        message: 'Avoid threatening language (e.g. "your account will be blocked"). Meta automatically rejects this.',
      };
    }
  }
  return { valid: true, message: '' };
};

// ---------------------------------------------------------------------------
// Full template validation — runs everything, returns first failure
// ---------------------------------------------------------------------------

/**
 * Validates a complete template draft before submission.
 * Returns { valid: boolean, errors: { field: message } }
 * — collects ALL errors (not just the first) so the form can highlight
 * every problem field at once.
 */
export const validateFullTemplate = ({
  name,
  category,
  language,
  bodyText,
  sampleValues = [],
  footer = '',
  headerText = '',
  buttons = [],
}) => {
  const errors = {};

  const nameResult = validateTemplateName(name);
  if (!nameResult.valid) errors.name = nameResult.message;

  const categoryResult = validateCategory(category);
  if (!categoryResult.valid) errors.category = categoryResult.message;

  const languageResult = validateLanguage(language);
  if (!languageResult.valid) errors.language = languageResult.message;

  const bodyResult = validateBodyText(bodyText);
  if (!bodyResult.valid) errors.bodyText = bodyResult.message;

  // Only check samples/content-policy if body itself is structurally valid
  if (bodyResult.valid) {
    const sampleResult = validateSampleValues(bodyText, sampleValues);
    if (!sampleResult.valid) errors.sampleValues = sampleResult.message;

    const policyResult = validateContentPolicy(bodyText);
    if (!policyResult.valid) errors.contentPolicy = policyResult.message;
  }

  const footerResult = validateFooter(footer);
  if (!footerResult.valid) errors.footer = footerResult.message;

  const headerResult = validateHeaderText(headerText);
  if (!headerResult.valid) errors.headerText = headerResult.message;

  const buttonsResult = validateButtons(buttons);
  if (!buttonsResult.valid) errors.buttons = buttonsResult.message;

  return { valid: Object.keys(errors).length === 0, errors };
};

// ---------------------------------------------------------------------------
// Component builder — converts validated form data into Meta's API shape
// ---------------------------------------------------------------------------

/**
 * Builds the `components` array Meta's createMetaTemplate expects,
 * from clean validated form fields.
 */
export const buildTemplateComponents = ({
  bodyText,
  sampleValues = [],
  footer = '',
  headerText = '',
  headerType = 'NONE', // NONE | TEXT | IMAGE | VIDEO | DOCUMENT
  buttons = [],
}) => {
  const components = [];

  // HEADER
  if (headerType === 'TEXT' && headerText.trim()) {
    const headerVars = [...headerText.matchAll(VARIABLE_REGEX)];
    components.push({
      type: 'HEADER',
      format: 'TEXT',
      text: headerText.trim(),
      ...(headerVars.length > 0
        ? { example: { header_text: [sampleValues[0] ?? ''] } }
        : {}),
    });
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType)) {
    components.push({ type: 'HEADER', format: headerType });
  }

  // BODY (always present)
  const bodyVars = [...bodyText.matchAll(VARIABLE_REGEX)];
  components.push({
    type: 'BODY',
    text: bodyText.trim(),
    ...(bodyVars.length > 0
      ? { example: { body_text: [sampleValues.slice(0, bodyVars.length)] } }
      : {}),
  });

  // FOOTER
  if (footer.trim()) {
    components.push({ type: 'FOOTER', text: footer.trim() });
  }

  // BUTTONS
  if (buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map((btn) => {
        if (btn.type === 'QUICK_REPLY') {
          return { type: 'QUICK_REPLY', text: btn.text.trim() };
        }
        if (btn.type === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER', text: btn.text.trim(), phone_number: btn.phone_number.trim() };
        }
        if (btn.type === 'URL') {
          return { type: 'URL', text: btn.text.trim(), url: btn.url.trim() };
        }
        return btn;
      }),
    });
  }

  return components;
};