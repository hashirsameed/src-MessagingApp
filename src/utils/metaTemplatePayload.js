/**
 * metaTemplatePayload.js
 *
 * Compiles component-wise form state (header/body text + sample values)
 * into the exact JSON shape Meta's Cloud API expects for template creation.
 *
 * Why component-wise sample state matters:
 *   Meta scopes variable indices PER COMPONENT. {{1}} in the HEADER and
 *   {{1}} in the BODY are two completely different variables. Flattening
 *   them into one array causes silent collisions (header sample overwrites
 *   body sample or vice versa). Keeping sampleValues = { header: [], body: [] }
 *   mirrors Meta's own internal model and avoids that entire class of bug.
 */

const VARIABLE_REGEX = /\{\{(\d+)\}\}/g;

// ---------------------------------------------------------------------------
// Name formatting
// ---------------------------------------------------------------------------

/**
 * Normalizes a template name to Meta's required format:
 * lowercase, trimmed, spaces/hyphens collapsed to single underscores.
 */
export const formatTemplateName = (rawName) => {
  return (rawName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
};

// ---------------------------------------------------------------------------
// Variable extraction helpers
// ---------------------------------------------------------------------------

/**
 * Returns the sorted, unique, numeric variable indices found in a string.
 * e.g. "Hi {{2}} and {{1}}" -> [1, 2]
 */
export const extractVariableIndices = (text) => {
  const matches = [...(text ?? '').matchAll(VARIABLE_REGEX)];
  const indices = matches.map((m) => parseInt(m[1], 10));
  return [...new Set(indices)].sort((a, b) => a - b);
};

// ---------------------------------------------------------------------------
// Component-level validation (used by the payload compiler as a final guard)
// ---------------------------------------------------------------------------

/**
 * Validates that a body/header text segment doesn't violate Meta's
 * structural rules around variable placement.
 * Returns { valid, message }.
 */
const validateVariablePlacement = (text, fieldLabel) => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { valid: true, message: '' };

  if (/^\{\{\d+\}\}/.test(trimmed)) {
    return { valid: false, message: `${fieldLabel} cannot start with a variable. Add text before {{1}}.` };
  }
  if (/\{\{\d+\}\}$/.test(trimmed)) {
    return { valid: false, message: `${fieldLabel} cannot end with a variable. Add text after the last variable.` };
  }
  if (/\}\}\{\{/.test(trimmed)) {
    return { valid: false, message: `${fieldLabel} cannot have two variables back-to-back. Add text between them.` };
  }

  const indices = extractVariableIndices(trimmed);
  if (indices.length > 0) {
    const expected = indices.map((_, i) => i + 1);
    const isSequential = indices.every((val, i) => val === expected[i]);
    if (!isSequential) {
      return {
        valid: false,
        message: `${fieldLabel} variables must be sequential starting at {{1}} with no gaps (found {{${indices.join('}}, {{')}}}).`,
      };
    }
  }

  return { valid: true, message: '' };
};

/**
 * Full pre-submission validation across header + body + sample completeness.
 * Returns { valid: boolean, errors: { field: message } }
 */
export const validateTemplatePayloadInputs = ({ name, headerText, bodyText, sampleValues }) => {
  const errors = {};

  const formattedName = formatTemplateName(name);
  if (!formattedName) {
    errors.name = 'Template name is required.';
  } else if (/[A-Z\s]/.test((name ?? ''))) {
    // Informational — name gets auto-lowered, but warn if raw input had issues
    // beyond what formatting silently fixes (kept for UX clarity only).
  }

  const headerResult = validateVariablePlacement(headerText, 'Header');
  if (!headerResult.valid) errors.headerText = headerResult.message;

  const bodyResult = validateVariablePlacement(bodyText, 'Body');
  if (!bodyResult.valid) errors.bodyText = bodyResult.message;

  if (headerResult.valid) {
    const headerIndices = extractVariableIndices(headerText);
    if (headerIndices.length > 0) {
      const sample = sampleValues?.header?.[0];
      if (!sample || !sample.trim()) {
        errors.headerSample = 'Sample value for header variable {{1}} is required.';
      }
    }
  }

  if (bodyResult.valid) {
    const bodyIndices = extractVariableIndices(bodyText);
    for (let i = 0; i < bodyIndices.length; i++) {
      const sample = sampleValues?.body?.[i];
      if (!sample || !sample.trim()) {
        errors.bodySample = `Sample value for body variable {{${bodyIndices[i]}}} is required.`;
        break;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
};

// ---------------------------------------------------------------------------
// Main payload compiler
// ---------------------------------------------------------------------------

/**
 * Builds the exact `components` + top-level payload Meta's Cloud API
 * expects for POST /{businessAccountId}/message_templates.
 *
 * @param {string} templateName
 * @param {string} category       UTILITY | MARKETING | AUTHENTICATION
 * @param {string} language       e.g. 'en_US'
 * @param {string} headerText     optional, may contain at most {{1}}
 * @param {string} bodyText       required, may contain {{1}}, {{2}}, ...
 * @param {{header: string[], body: string[]}} sampleValues
 * @param {string} [footer]       optional, no variables allowed
 * @returns {{ name: string, category: string, language: string, components: Array }}
 */
export const buildMetaTemplatePayload = (
  templateName,
  category,
  language,
  headerText,
  bodyText,
  sampleValues,
  footer = '',
) => {
  const name = formatTemplateName(templateName);
  const components = [];

  // ── HEADER ──────────────────────────────────────────────────────────────
  const trimmedHeader = (headerText ?? '').trim();
  if (trimmedHeader) {
    const headerIndices = extractVariableIndices(trimmedHeader);
    const headerComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: trimmedHeader,
    };

    if (headerIndices.length > 0) {
      const headerSample = sampleValues?.header?.[0] ?? '';
      headerComponent.example = {
        header_text: [headerSample],
      };
    }

    components.push(headerComponent);
  }

  // ── BODY (always required) ─────────────────────────────────────────────
  const trimmedBody = (bodyText ?? '').trim();
  const bodyIndices = extractVariableIndices(trimmedBody);

  const bodyComponent = {
    type: 'BODY',
    text: trimmedBody,
  };

  if (bodyIndices.length > 0) {
    // Map sorted indices to zero-indexed sampleValues.body slots,
    // wrapped in Meta's required double-array format: [[s1, s2, ...]]
    const orderedSamples = bodyIndices.map((_, i) => sampleValues?.body?.[i] ?? '');
    bodyComponent.example = {
      body_text: [orderedSamples],
    };
  }

  components.push(bodyComponent);

  // ── FOOTER (optional, no variables) ────────────────────────────────────
  const trimmedFooter = (footer ?? '').trim();
  if (trimmedFooter) {
    components.push({ type: 'FOOTER', text: trimmedFooter });
  }

  return {
    name,
    category,
    language,
    components,
  };
};