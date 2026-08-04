/* Policy Translator — PROTOTYPE front-end ("apply" experience)
 * Reuses the real /api/analyze engine; the /api/apply call is simulated.
 */

const state = {
  rawJson: null,
  analysis: null,
  selected: new Set(),   // StepKinds the user wants to configure
  config: {},
  migrationMode: "preserve",
  branding: { companyName: "", accent: "#0067b8", logo: "", bg: "#f3f6fb", backgroundImage: "" },
  brandingDetected: null,
  brandingDirty: new Set(),
  brandingImport: null,   // ImportedBranding read from the source B2C tenant
  brandingAuth: null,     // { sessionId, timer } for the source-tenant device-code
  auth: null,
  finalGapReport: "",
};

const selectedModernizationExtras = () => {
  const detected = new Set((state.analysis?.steps || []).map((step) => step.kind));
  return orderedSelected().filter((kind) => EXTRA_ORDER.includes(kind) && !detected.has(kind));
};

// StepKind → catalog entry (label, file, scopes, grouping, idp key)
const CATALOG = {
  "create-native-app":              { label: "Native app registration",            scopes: ["Application.ReadWrite.All"], core: true },
  "create-user-flow-emailpassword": { label: "Sign-up / sign-in user flow",         scopes: ["EventListener.ReadWrite.All", "IdentityUserFlow.ReadWrite.All"], core: true },
  "smoke-test-native-auth":         { label: "Native-auth wiring check (read-only)", scopes: ["Organization.Read.All", "EventListener.Read.All"], core: true },
  "add-google-idp":                 { label: "Google sign-in",                      scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All", "Organization.Read.All"], idp: "google", group: "Google Identity Provider" },
  "add-facebook-idp":               { label: "Facebook sign-in",                    scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All"], idp: "facebook", group: "Facebook Identity Provider" },
  "add-oidc-idp":                   { label: "Custom OIDC sign-in",                 scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All"], idp: "oidc", group: "Custom OIDC Identity Provider" },
  "add-apple-idp":                  { label: "Apple sign-in",                       scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All", "Organization.Read.All"], idp: "apple", group: "Apple Identity Provider" },
  "enable-email-otp":               { label: "Email OTP authentication method",     scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "enable-sms-mfa":                 { label: "SMS one-time passcode (MFA)",         scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "create-ca-policy":               { label: "Conditional Access (require MFA)",    scopes: ["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"], group: "Conditional Access" },
  "enable-passkey":                 { label: "Passkey (FIDO2)",                     scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "claims-mapping-policy":          { label: "Claims mapping policy",               scopes: ["Policy.ReadWrite.ApplicationConfiguration", "Application.ReadWrite.All"] },
  "enable-sspr":                    { label: "Self-service password reset",         scopes: ["EventListener.ReadWrite.All", "Policy.ReadWrite.AuthenticationMethod"] },
  "create-custom-attributes":       { label: "Custom user attributes",              scopes: ["IdentityUserFlow.ReadWrite.All", "EventListener.ReadWrite.All"] },
};

const SCOPE_DESCRIPTIONS = {
  "Application.ReadWrite.All": "create and update app registrations",
  "IdentityProvider.ReadWrite.All": "create and update identity providers",
  "EventListener.ReadWrite.All": "create and update user flows",
  "IdentityUserFlow.ReadWrite.All": "create and update custom user attributes",
  "Policy.ReadWrite.AuthenticationMethod": "configure authentication methods (email OTP, SMS, passkey)",
  "Policy.ReadWrite.ConditionalAccess": "create and update Conditional Access policies",
  "Policy.Read.All": "read existing Conditional Access policies before creating or reusing one",
  "Policy.ReadWrite.ApplicationConfiguration": "configure claims mapping policies",
  "Organization.Read.All": "read tenant details (used to discover your domain)",
  "EventListener.Read.All": "verify the expected application is bound to the target user flow",
  "OrganizationalBranding.ReadWrite.All": "apply company branding to the hosted sign-in experience",
};
const SCOPE_ROLES = {
  "Application.ReadWrite.All": "Application Administrator",
  "Policy.ReadWrite.ApplicationConfiguration": "Application Administrator",
  "IdentityProvider.ReadWrite.All": "External Identity Provider Administrator",
  "EventListener.ReadWrite.All": "External ID user-flow administrator",
  "IdentityUserFlow.ReadWrite.All": "External ID user-flow administrator",
  "Policy.ReadWrite.AuthenticationMethod": "Authentication Policy Administrator",
  "Policy.ReadWrite.ConditionalAccess": "Conditional Access Administrator",
  "Policy.Read.All": "Conditional Access Administrator",
  "OrganizationalBranding.ReadWrite.All": "Organizational Branding Administrator",
};
const IDP_MARK = {
  google:   { text: "G", bg: "#4285F4", label: "Continue with Google" },
  facebook: { text: "f", bg: "#1877F2", label: "Continue with Facebook" },
  apple:    { text: "A", bg: "#000000", label: "Continue with Apple" },
  oidc:     { text: "ID", bg: "#5c2e91", label: "Continue with Partner" },
};

// One-line "why add this" pitch for the upsell (features External ID supports
// that were NOT in the customer's B2C policy).
const PITCH = {
  "enable-passkey": "Enable the FIDO2 policy; rollout still needs a local password account, recent MFA, Azure Front Door, a custom domain, and passkey enrollment.",
  "create-ca-policy": "Enforce MFA with a Conditional Access policy (starts report-only).",
  "enable-sms-mfa": "Add SMS one-time passcode as a second factor.",
  "enable-email-otp": "Enable Email OTP for MFA and password reset; primary passwordless sign-in still needs explicit user-flow configuration.",
  "enable-sspr": "Let users reset their own password — fewer support tickets.",
};

// Which extras to offer as "new in External ID" (shown only if not already detected).
const EXTRA_ORDER = [
  "enable-passkey", "create-ca-policy", "enable-sms-mfa",
  "enable-email-otp", "enable-sspr",
];

// Canonical apply/preview order (mirrors the 01..14 script numbering) so both
// detected steps and opted-in extras provision in a deterministic sequence.
const ALL_ORDER = [
  "create-native-app", "create-user-flow-emailpassword", "smoke-test-native-auth",
  "add-google-idp", "add-facebook-idp", "add-oidc-idp", "enable-email-otp",
  "claims-mapping-policy", "enable-sspr", "add-apple-idp", "enable-sms-mfa",
  "create-ca-policy", "enable-passkey", "create-custom-attributes",
];
const STEP_DEPENDENCIES = {
  "create-user-flow-emailpassword": ["create-native-app"],
  "smoke-test-native-auth": ["create-native-app", "create-user-flow-emailpassword"],
  "add-google-idp": ["create-native-app", "create-user-flow-emailpassword"],
  "add-facebook-idp": ["create-native-app", "create-user-flow-emailpassword"],
  "enable-email-otp": ["create-native-app"],
  "enable-sms-mfa": ["create-native-app"],
  "create-ca-policy": ["create-native-app"],
  "enable-passkey": ["create-native-app"],
  "claims-mapping-policy": ["create-native-app"],
  "enable-sspr": ["create-native-app", "create-user-flow-emailpassword"],
  "create-custom-attributes": ["create-native-app", "create-user-flow-emailpassword"],
};
const orderedSelected = () => {
  const resolved = new Set();
  const add = (kind) => {
    (STEP_DEPENDENCIES[kind] || []).forEach(add);
    resolved.add(kind);
  };
  state.selected.forEach(add);
  return ALL_ORDER.filter((kind) => resolved.has(kind));
};

// True when the user imported branding or customised it away from the UI
// defaults — i.e. there is something meaningful to write to Company Branding.
function hasBrandingToWrite() {
  return Boolean(
    state.brandingImport ||
    state.brandingDetected?.hasConcreteValues ||
    (state.migrationMode === "modernize" && state.brandingDirty.size > 0),
  );
}

function detectedBrandingPayload() {
  const detected = state.brandingDetected;
  if (!detected?.hasConcreteValues) return undefined;
  return {
    hasBranding: true,
    ...(detected.backgroundColor ? { backgroundColor: detected.backgroundColor } : {}),
    ...(detected.accentColor ? { accentColor: detected.accentColor } : {}),
    ...(detected.logoUrl ? { bannerLogoUrl: detected.logoUrl } : {}),
    ...(detected.backgroundImageUrl ? { backgroundImageUrl: detected.backgroundImageUrl } : {}),
  };
}

function sourceBrandingPayload() {
  return state.brandingImport || detectedBrandingPayload();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function showStep(n) {
  for (let i = 1; i <= 5; i++) { const p = $(`#panel-${i}`); if (p) p.hidden = i !== n; }
  $$(".stepper li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._timer); t._timer = setTimeout(() => (t.hidden = true), 2200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function safeDocLink(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ["learn.microsoft.com", "aka.ms"].includes(url.hostname.toLowerCase())
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function guidanceHtml(note, docLink) {
  const link = safeDocLink(docLink);
  if (!note && !link) return "";
  return `<div class="feature-guidance">${note ? `<span>${escapeHtml(note)}</span>` : ""}${link ? `<a class="doc-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Microsoft Learn</a>` : ""}</div>`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let csrfTokenPromise = null;
async function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch("/api/security-token", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || !data.token) throw new Error(data.error || "Could not initialize the local session.");
        return data.token;
      })
      .catch((err) => {
        csrfTokenPromise = null;
        throw err;
      });
  }
  return csrfTokenPromise;
}

async function apiFetch(url, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return fetch(url, init);
  const token = await getCsrfToken();
  const headers = new Headers(init.headers || {});
  headers.set("X-Policy-Translator-CSRF", token);
  headers.set("X-Policy-Translator-Telemetry", telemetryPreferenceEnabled() ? "on" : "off");
  return fetch(url, { ...init, headers });
}

const TELEMETRY_PREFERENCE_KEY = "policyTranslator.telemetryEnabled";
let telemetryPreference = readTelemetryPreference();

function telemetryPreferenceEnabled() {
  return telemetryPreference;
}

function readTelemetryPreference() {
  try {
    return localStorage.getItem(TELEMETRY_PREFERENCE_KEY) !== "off";
  } catch {
    return false;
  }
}

function saveTelemetryPreference(enabled) {
  telemetryPreference = Boolean(enabled);
  try {
    localStorage.setItem(TELEMETRY_PREFERENCE_KEY, telemetryPreference ? "on" : "off");
  } catch {
    telemetryPreference = false;
  }
  return telemetryPreference;
}

async function syncTelemetryPreference() {
  const enabled = telemetryPreferenceEnabled();
  const toggle = $("#telemetryToggle");
  const status = $("#telemetryStatus");
  toggle.checked = enabled;
  try {
    const res = await apiFetch("/api/telemetry/preference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = await res.json();
    status.textContent = data.configured
      ? (data.enabled ? "Anonymous metrics are on" : "Anonymous metrics are off")
      : "Telemetry is inactive in this build";
  } catch {
    status.textContent = "Telemetry is unavailable";
  }
}

function sendClientTelemetry(eventName, count) {
  if (!telemetryPreferenceEnabled()) return;
  void apiFetch("/api/telemetry/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventName, count }),
  }).catch(() => {});
}

// Turn a raw feature key (e.g. "global_ux_advancedUiCustomization") into a
// readable label. Safe/idempotent on strings that are already human-readable.
function prettifyKey(key) {
  if (!key) return "";
  const noise = new Set(["global", "signup", "signin", "idp", "ux", "infra", "token", "attributes", "partner", "policy"]);
  const acronyms = { ui: "UI", api: "API", url: "URL", otp: "OTP", sms: "SMS", mfa: "MFA", oidc: "OIDC", sspr: "SSPR", ca: "CA", rest: "REST", saml: "SAML", jwt: "JWT" };
  const parts = String(key).split("_");
  const kept = parts.filter((p, i) => !(i < parts.length - 1 && noise.has(p.toLowerCase())));
  const words = kept.join(" ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.split(/\s+/).map((w) => acronyms[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}
// Prefer an imported feature's friendly name/description; else prettify the key.
function featureLabel(raw) {
  if (!raw) return "";
  const feats = state.analysis?.features || [];
  const hit = feats.find((f) => f.name === raw || f.key === raw);
  if (hit && hit.name && hit.name !== raw) return hit.name;
  return prettifyKey(raw);
}

function occurrenceSuffix(item, collection) {
  if (!item?.occurrence && !item?.featureOccurrence) return "";
  return ` · journey ${item.occurrence || item.featureOccurrence}`;
}

// ─── Step 1: upload ──────────────────────────────────────────────────────────
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
$("#browseBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) readFile(e.target.files[0]); });
["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

$("#pasteToggle").addEventListener("click", (e) => { e.preventDefault(); $("#pasteArea").hidden = !$("#pasteArea").hidden; });
$("#analyzePasteBtn").addEventListener("click", () => {
  try { const json = JSON.parse($("#jsonInput").value); analyze(json); }
  catch (err) { showUploadError("That isn't valid JSON: " + err.message); }
});
$("#sampleBtn").addEventListener("click", (e) => { e.preventDefault(); analyze(SAMPLE_POLICY); });

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => { try { analyze(JSON.parse(reader.result)); } catch (err) { showUploadError("Couldn't parse that file: " + err.message); } };
  reader.readAsText(file);
}
function showUploadError(msg) { const el = $("#uploadError"); el.textContent = msg; el.hidden = false; }

async function analyze(json) {
  $("#uploadError").hidden = true;
  state.rawJson = json;
  try {
    const res = await apiFetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json }) });
    const data = await res.json();
    if (!data.valid) {
      showUploadError((data.errors || []).map((e) => e.message || e).join("; ") || "Validation failed.");
      return;
    }
    state.analysis = data;
    state.selected = new Set(data.steps.map((s) => s.kind));  // default: everything on
    state.migrationMode = "preserve";
    state.brandingImport = null;
    state.brandingDetected = data.context.branding || null;
    state.brandingDirty = new Set();
    state.finalGapReport = "";
    resetBrandingFromAnalysis();
    // Autodetect app + flow names from the analyzed policy so the config is prefilled.
    if (data.context.appName) state.config.appName = data.context.appName;
    if (data.context.flowName) state.config.flowName = data.context.flowName;
    renderReview();
    showStep(2);
  } catch (err) { showUploadError("Server error: " + err.message); }
}

// ─── Step 2: review ──────────────────────────────────────────────────────────
function renderReview() {
  const a = state.analysis;
  $("#policyNameLabel").textContent = a.policyName;
  $("#analyzerReadinessLabel").textContent = a.readiness.analyzerScore
    ? `Policy Analyzer platform readiness: ${a.readiness.analyzerScore}`
    : "Policy Analyzer platform readiness: not provided";
  const pct = a.readiness.percent;
  $("#gaugePct").textContent = pct + "%";
  $("#gauge").style.background = `conic-gradient(var(--brand) ${pct}%, var(--line) 0%)`;
  $("#readinessScore").textContent = a.readiness.score;

  $("#statRow").innerHTML = [
    { n: a.readiness.total, l: "Features detected" },
    { n: a.readiness.ready, l: "Ready to migrate" },
    { n: state.selected.size, l: "Steps to configure" },
    { n: a.gaps.length, l: "Manual follow-ups" },
  ].map((s) => `<div class="stat-card"><div class="num">${s.n}</div><div class="lbl">${s.l}</div></div>`).join("");

  const tbody = $("#featureTable tbody");
  tbody.innerHTML = a.features.map((f) => `
    <tr>
      <td>
        <span class="feat-name">${escapeHtml(f.name)}</span>
        ${occurrenceSuffix(f, a.features) ? `<span class="muted small">${escapeHtml(occurrenceSuffix(f, a.features))}</span>` : ""}
        ${f.description ? `<div class="muted small">${escapeHtml(f.description)}</div>` : ""}
        ${guidanceHtml(f.guidance, f.docLink)}
      </td>
      <td><span class="pill ${f.status}">${escapeHtml(f.statusLabel)}</span></td>
    </tr>`).join("");

  $("#gapCount").textContent = a.gaps.length ? `(${a.gaps.length})` : "(none)";
  $("#gapList").innerHTML = a.gaps.length
    ? a.gaps.map((g) => `<li><strong>${escapeHtml(featureLabel(g.feature) + occurrenceSuffix(g, a.gaps))}</strong><span class="muted small"> — ${escapeHtml(g.recommendation)}</span>${guidanceHtml(g.notes, g.docLink)}</li>`).join("")
    : `<li class="muted">Everything detected maps cleanly. Nothing needs manual work.</li>`;
}
$("#backTo1").addEventListener("click", () => showStep(1));
$("#goTo3").addEventListener("click", () => {
  renderSelect();
  prefillBrandInputs();
  syncMigrationModeUi();
  updatePreview();
  showStep(3);
});

function resetBrandingFromAnalysis() {
  const detected = state.brandingDetected || {};
  state.branding = {
    companyName: state.analysis?.context?.appName || "Your app",
    accent: normalizeColor(detected.accentColor, "#0067b8"),
    logo: detected.logoUrl || "",
    bg: normalizeColor(detected.backgroundColor, "#f3f6fb"),
    backgroundImage: detected.backgroundImageUrl || "",
  };
}

function migrationModeNote() {
  if (state.migrationMode === "modernize") {
    return "Detected capabilities stay selected. You can add External ID features and refine the branding before applying.";
  }
  if (state.brandingImport) {
    return "Closest 1:1 mode: only detected capabilities are selected, and the imported B2C branding is preserved.";
  }
  if (state.brandingDetected?.hasConcreteValues) {
    return "Closest 1:1 mode: detected branding values are preserved. Import from B2C to verify the exact assets.";
  }
  if (state.brandingDetected?.hasSignal) {
    return "Closest 1:1 mode: branding was detected, but the analyzer did not include its assets. Import from B2C for an exact recreation.";
  }
  return "Closest 1:1 mode: only capabilities detected in the source policy will be applied.";
}

function syncMigrationModeUi() {
  $$('input[name="migrationMode"]').forEach((radio) => {
    radio.checked = radio.value === state.migrationMode;
  });
  $("#migrationModeNote").textContent = migrationModeNote();
  setBrandControlsLocked(state.migrationMode === "preserve");
}

$$('input[name="migrationMode"]').forEach((radio) => radio.addEventListener("change", (e) => {
  state.migrationMode = e.target.value === "modernize" ? "modernize" : "preserve";
  if (state.migrationMode === "preserve") {
    state.selected = new Set(state.analysis.steps.map((s) => s.kind));
    state.brandingDirty = new Set();
    if (state.brandingImport) applyImportedBranding(state.brandingImport, false);
    else resetBrandingFromAnalysis();
    prefillBrandInputs();
  }
  renderSelect();
  syncMigrationModeUi();
  updatePreview();
}));

// Lock the manual pickers behind a read-only "recreated from your B2C tenant" state
// once real branding is imported; otherwise leave them as a labeled fallback.
function setBrandControlsLocked(locked) {
  const controls = $("#brandControls");
  const lockedNote = $("#brandLockedNote");
  const manualLabel = $("#brandManualLabel");
  const previewNote = $("#previewNote");
  if (controls) controls.hidden = locked;
  if (lockedNote) lockedNote.hidden = !locked;
  if (manualLabel) manualLabel.hidden = locked;
  if (lockedNote) {
    const text = lockedNote.querySelector("span:last-child");
    if (text) text.textContent = state.brandingImport
      ? "Read from your Azure AD B2C tenant. Closest 1:1 mode preserves these values when applying to External ID."
      : state.brandingDetected?.hasConcreteValues
        ? "Detected from the analyzer output. Import from B2C to verify the exact assets before applying."
        : state.brandingDetected?.hasSignal
          ? "Branding was detected, but the analyzer did not include the logo or colors. Import from B2C to recreate it."
          : "No source branding was detected, so closest 1:1 mode will not change Company Branding.";
  }
  if (previewNote) {
    previewNote.textContent = locked
      ? "Closest supported representation of the source policy. The hosted External ID layout is not pixel-perfect."
      : "Modernized External ID preview. The hosted layout is representative, not pixel-perfect.";
  }
}

// Prefill the brand controls from detected/imported values so the preview isn't generic.
function prefillBrandInputs() {
  const name = state.branding.companyName || state.analysis?.context.appName || "";
  if (name) { $("#brandName").value = name; state.branding.companyName = name; }
  $("#brandAccent").value = normalizeColor(state.branding.accent, "#0067b8");
  $("#brandBg").value = normalizeColor(state.branding.bg, "#f3f6fb");
  $("#brandLogo").value = state.branding.logo && !/^data:/.test(state.branding.logo) ? state.branding.logo : "";
  if ($("#brandLogoFile")) $("#brandLogoFile").value = "";
}
function normalizeColor(v, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(v || "") ? v : fallback;
}

// ─── Step 3: select + brand + preview ────────────────────────────────────────
function selectItemHtml(kind, metaText, isExtra) {
  const c = CATALOG[kind] || { label: kind };
  const checked = state.selected.has(kind);
  const badge = isExtra ? "New" : (c.core ? "Required" : "Optional");
  const badgeClass = isExtra ? "new" : (c.core ? "req" : "");
  return `
    <label class="select-item ${checked ? "checked" : ""} ${c.core ? "core" : ""}" data-kind="${kind}">
      <input type="checkbox" ${checked ? "checked" : ""} ${c.core ? "disabled" : ""} data-kind="${kind}" />
      <span class="si-body">
        <span class="si-title">${escapeHtml(c.label)}</span>
        <span class="si-meta">${escapeHtml(metaText || "")}</span>
      </span>
      <span class="si-badge ${badgeClass}">${badge}</span>
    </label>`;
}
function renderSelect() {
  const detectedKinds = new Set(state.analysis.steps.map((s) => s.kind));
  const detected = state.analysis.steps.map((s) => {
    const why = (s.features || []).length ? `Detected: ${s.features.slice(0, 3).join(", ")}${s.features.length > 3 ? "…" : ""}` : "";
    return selectItemHtml(s.kind, why, false);
  }).join("");

  const extras = EXTRA_ORDER
    .filter((k) => !detectedKinds.has(k));
  const extrasHtml = extras.map((k) => selectItemHtml(k, PITCH[k] || "", true)).join("");
  const showExtras = state.migrationMode === "modernize" && extras.length > 0;

  $("#selectList").innerHTML = `
    <div class="select-section-title">In your policy</div>
    ${detected}
    ${showExtras ? `
      <div class="select-section-title upsell">New in External ID — add these too?</div>
      <p class="muted small upsell-note">Not in your B2C policy, but easy to switch on now. Toggle any on and watch the preview update.</p>
      ${extrasHtml}` : ""}
  `;

  $("#selectList").querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const kind = cb.dataset.kind;
      if (cb.checked) state.selected.add(kind); else state.selected.delete(kind);
      cb.closest(".select-item").classList.toggle("checked", cb.checked);
      updatePreview();
    });
  });
}

["brandName", "brandAccent", "brandLogo", "brandBg"].forEach((id) => {
  $("#" + id).addEventListener("input", () => {
    const dirtyKey = { brandAccent: "accent", brandLogo: "logo", brandBg: "bg" }[id];
    if (dirtyKey) state.brandingDirty.add(dirtyKey);
    state.branding.companyName = $("#brandName").value || state.analysis?.context.appName || "Your app";
    state.branding.accent = $("#brandAccent").value;
    state.branding.logo = $("#brandLogo").value.trim();
    state.branding.bg = $("#brandBg").value;
    updatePreview();
  });
});

// Logo file upload → inline data URL (preview-only). Keeps the URL field usable
// for hosted logos; a picked file wins and clears the text input.
const brandLogoFile = $("#brandLogoFile");
if (brandLogoFile) {
  brandLogoFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast("Pick an image file (PNG, JPG, or SVG)."); e.target.value = ""; return; }
    if (f.size > 1024 * 1024) { toast("Logo must be under 1 MB."); e.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      state.brandingDirty.add("logo");
      state.branding.logo = String(reader.result);
      $("#brandLogo").value = "";
      updatePreview();
    };
    reader.readAsDataURL(f);
  });
}

function buildPreviewCard(b, selected) {
  const accent = b.accent || "#0067b8";
  const name = b.companyName || "Your app";
  const logoUrl = safeBrandAsset(b.logo);
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${escapeHtml(name[0] || "A").toUpperCase()}'" />`
    : escapeHtml((name[0] || "A").toUpperCase());
  const idps = ALL_ORDER.filter((k) => selected.has(k)).map((k) => CATALOG[k]?.idp).filter(Boolean);
  const idpHtml = idps.map((key) => {
    const m = IDP_MARK[key]; if (!m) return "";
    return `<div class="login-idp"><span class="idp-mark" style="background:${m.bg}">${m.text}</span>${escapeHtml(m.label)}</div>`;
  }).join("");
  const hasPasswordFlow = selected.has("create-user-flow-emailpassword");
  const hasEmailOtp = selected.has("enable-email-otp");
  const forgot = hasPasswordFlow && selected.has("enable-sspr")
    ? `<div class="login-forgot" style="color:${accent}">Forgot password?</div>`
    : "";
  const orBlock = idps.length ? `<div class="login-or"><span>or</span></div>` : "";
  const fields = hasPasswordFlow
    ? `<div class="login-field"><span>Email</span></div>
      <div class="login-field"><span>Password</span></div>`
    : hasEmailOtp
      ? `<div class="login-field"><span>Email</span></div>`
      : "";
  const title = hasPasswordFlow || hasEmailOtp ? "Sign in" : "Branding preview";
  const subtitle = hasPasswordFlow
    ? `to continue to ${escapeHtml(name)}`
    : hasEmailOtp
      ? `Email OTP user-flow configuration required for ${escapeHtml(name)}`
      : "Authentication flow not selected";
  const primaryAction = hasPasswordFlow
    ? `<button class="login-primary" style="background:${accent}" type="button">Sign in</button>`
    : hasEmailOtp
      ? `<button class="login-primary" style="background:${accent}" type="button">Continue</button>`
      : "";
  const signup = hasPasswordFlow || hasEmailOtp
    ? `<div class="login-signup">No account? <span style="color:${accent}">Create one</span></div>`
    : "";
  return `
    <div class="login-card" style="border-top:3px solid ${accent}">
      <div class="login-logo" style="background:${accent}">${logo}</div>
      <div class="login-title">${title}</div>
      <div class="login-sub">${subtitle}</div>
      ${fields}
      ${forgot}
      ${primaryAction}
      ${orBlock}
      <div class="login-idps">${idpHtml}</div>
      ${signup}
    </div>`;
}
function updatePreview() {
  const mount = $("#loginPreview");
  applyPreviewBackground(mount, state.branding);
  mount.innerHTML = buildPreviewCard(state.branding, new Set(orderedSelected()));
}

function safeBrandAsset(value) {
  const url = String(value || "").trim();
  return /^(?:https:\/\/|data:image\/)/i.test(url) ? url : "";
}

function applyPreviewBackground(mount, branding) {
  mount.style.backgroundColor = branding?.bg || "#f3f6fb";
  const image = safeBrandAsset(branding?.backgroundImage);
  mount.style.backgroundImage = image ? `url("${image.replace(/"/g, "%22")}")` : "";
  mount.style.backgroundSize = image ? "cover" : "";
  mount.style.backgroundPosition = image ? "center" : "";
}
$("#backTo2").addEventListener("click", () => showStep(2));
$("#goTo4").addEventListener("click", () => { renderConfig(); showStep(4); });

// ─── Step 4: configure ───────────────────────────────────────────────────────
function configFields() {
  const a = state.analysis;
  const core = [
    { key: "tenantId", label: "Tenant ID", type: "text", required: true, group: "External ID Tenant", placeholder: "00000000-0000-0000-0000-000000000000", help: "Directory (tenant) ID of your External ID tenant." },
    { key: "appName", label: "App name", type: "text", required: false, group: "External ID Tenant", placeholder: a.context.appName || "migrated-app", help: "Display name for the new app registration." },
    { key: "flowName", label: "User flow name", type: "text", required: false, group: "External ID Tenant", placeholder: a.context.flowName || "SignUpSignIn", help: "Name of the sign-up / sign-in user flow." },
    { key: "bundleId", label: "App bundle ID", type: "text", required: false, group: "External ID Tenant", placeholder: "com.contoso.yourapp", help: "iOS bundle / Android package for the native app." },
  ];
  const selectedGroups = new Set([...state.selected].map((k) => CATALOG[k]?.group).filter(Boolean));
  const idpFields = (a.requiredInputs || [])
    .filter((f) => selectedGroups.has(f.group))
    .map((f) => ({
      ...f,
      required: true,
      help: String(f.help || "").replace(/\s*Leave blank to skip this provider.*$/i, ""),
    }));
  return core.concat(idpFields);
}
function renderConfig() {
  const fields = configFields();
  const groups = {};
  fields.forEach((f) => { (groups[f.group] = groups[f.group] || []).push(f); });
  $("#configForm").innerHTML = Object.entries(groups).map(([group, fs]) => `
    <div class="config-group">
      <div class="config-group-title">${escapeHtml(group)}</div>
      ${fs.map((f) => `
        <div class="field">
          <label for="cfg-${f.key}">${escapeHtml(f.label)}${f.required ? ' <span class="req-star">*</span>' : ""}</label>
          <input id="cfg-${f.key}" name="${f.key}" type="${f.type === "password" ? "password" : "text"}"
                 placeholder="${escapeHtml(f.placeholder || "")}" value="${escapeHtml(state.config[f.key] || "")}" />
          <p class="field-help">${escapeHtml(f.help || "")}</p>
        </div>`).join("")}
    </div>`).join("");
}
$("#backTo3").addEventListener("click", () => showStep(3));
$("#configForm").addEventListener("input", (e) => {
  if (e.target.matches("input, textarea")) e.target.classList.remove("invalid");
});

function captureConfig() {
  $$("#configForm input[name], #configForm textarea[name]").forEach((inp) => { state.config[inp.name] = inp.value.trim(); });
}

function validateConfig(requireExecutionInputs) {
  const fields = configFields();
  const missing = fields.filter((f) =>
    (f.key === "tenantId" || (requireExecutionInputs && f.required)) &&
    !state.config[f.key],
  );
  if (missing.length) {
    missing.forEach((f) => { const el = $(`#cfg-${f.key}`); if (el) el.classList.add("invalid"); });
    const first = $(`#cfg-${missing[0].key}`);
    if (first) first.focus();
    toast(`${missing[0].label} is required.`);
    return false;
  }
  const tenantId = state.config.tenantId;
  const tenantIsGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId);
  const tenantIsDomain = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.onmicrosoft\.com$/i.test(tenantId);
  if (!tenantIsGuid && !tenantIsDomain) {
    const tenant = $("#cfg-tenantId");
    if (tenant) {
      tenant.classList.add("invalid");
      tenant.focus();
    }
    toast("Enter a tenant GUID or an onmicrosoft.com tenant domain.");
    return false;
  }
  const invalidGuid = fields.find((f) =>
    f.key !== "tenantId" &&
    f.type === "guid" &&
    state.config[f.key] &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.config[f.key]),
  );
  if (invalidGuid) {
    const field = $(`#cfg-${invalidGuid.key}`);
    if (field) {
      field.classList.add("invalid");
      field.focus();
    }
    toast(`${invalidGuid.label} must be a GUID.`);
    return false;
  }
  return true;
}

$("#reviewApplyBtn").addEventListener("click", () => {
  captureConfig();
  if (!validateConfig(false)) return;
  openConsent();
});

// ─── Consent + preview gate ──────────────────────────────────────────────────
function selectedScopes() {
  const scopes = new Set();
  orderedSelected().forEach((k) => (CATALOG[k]?.scopes || []).forEach((s) => scopes.add(s)));
  if (hasBrandingToWrite()) scopes.add("OrganizationalBranding.ReadWrite.All");
  return [...scopes];
}
function openConsent() {
  $("#consentActions").innerHTML = orderedSelected()
    .map((k) => `<li>${escapeHtml(CATALOG[k]?.label || k)}</li>`).join("");
  const scopes = selectedScopes();
  $("#consentScopes").innerHTML = scopes.length
    ? scopes.map((s) => `<li><code>${escapeHtml(s)}</code> <span class="muted small">— ${escapeHtml(SCOPE_DESCRIPTIONS[s] || "")}</span></li>`).join("")
    : `<li class="muted">No write permissions needed.</li>`;
  const roles = [...new Set(scopes.map((s) => SCOPE_ROLES[s]).filter(Boolean))];
  $("#consentRoles").innerHTML = roles.map((r) => `<li>${escapeHtml(r)}</li>`).join("") || `<li class="muted">None</li>`;
  applyPreviewBackground($("#consentPreviewMount"), state.branding);
  $("#consentPreviewMount").innerHTML = buildPreviewCard(state.branding, new Set(orderedSelected()));
  $("#consentAgree").checked = false;
  $("#consentProceed").disabled = true;
  const sim = document.querySelector('input[name="applyMode"][value="simulate"]');
  if (sim) sim.checked = true;
  updateConsentMode();
  $("#consentBackdrop").hidden = false;
}
function closeConsent() { $("#consentBackdrop").hidden = true; }
$("#consentCancel").addEventListener("click", closeConsent);
$("#consentCancelX").addEventListener("click", closeConsent);
$("#consentAgree").addEventListener("change", (e) => { $("#consentProceed").disabled = !e.target.checked; });

function currentApplyMode() {
  const el = document.querySelector('input[name="applyMode"]:checked');
  return el ? el.value : "simulate";
}
function updateConsentMode() {
  const real = currentApplyMode() === "real";
  $("#consentAgreeText").textContent = real
    ? "I understand this will make real changes to my External ID tenant."
    : "I understand this is a simulated apply in the prototype (no real changes).";
  $("#consentProceed").textContent = real ? "Sign in & apply" : "Apply to External ID";
}
$$('input[name="applyMode"]').forEach((r) => r.addEventListener("change", updateConsentMode));

$("#consentProceed").addEventListener("click", () => {
  const mode = currentApplyMode();
  if (mode === "real" && !validateConfig(true)) {
    closeConsent();
    showStep(4);
    return;
  }
  closeConsent();
  if (mode === "real") startRealApply();
  else runApply();
});

// ─── Step 5: mock apply ──────────────────────────────────────────────────────
async function runApply() {
  showStep(5);
  const orderedKinds = orderedSelected();
  $("#deviceAuth").hidden = true;
  $("#applyGrid").hidden = false;
  $("#applyGaps").hidden = true;
  $("#applyHeading").innerHTML = `<span class="spin">⟳</span> Applying to External ID…`;
  $("#applySubLabel").textContent = "Simulated provisioning — no tenant is modified.";
  $("#applyActions").hidden = true;
  $("#applyPreviewCol").hidden = true;

  const prog = $("#applyProgress");
  prog.innerHTML = orderedKinds.map((k) =>
    `<li class="pending" data-kind="${k}"><span class="ap-icon">•</span><span>${escapeHtml(CATALOG[k]?.label || k)}</span><span class="ap-id"></span></li>`).join("");

  let result;
  try {
    const res = await apiFetch("/api/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedKinds: orderedKinds,
        selectedExtras: selectedModernizationExtras(),
        config: state.config,
        branding: state.branding,
        gapCount: state.analysis?.gaps?.length || 0,
      }),
    });
    result = await res.json();
  } catch (err) { toast("Apply failed: " + err.message); return; }

  const byKind = {}; (result.applied || []).forEach((a) => (byKind[a.kind] = a));
  for (const k of orderedKinds) {
    const li = prog.querySelector(`li[data-kind="${k}"]`);
    li.classList.remove("pending"); li.classList.add("running");
    li.querySelector(".ap-icon").textContent = "⟳";
    await sleep(420 + Math.random() * 260);
    li.classList.remove("running"); li.classList.add("done");
    li.querySelector(".ap-icon").textContent = "–";
    const r = byKind[k];
    const id = r && r.resource ? (r.resource.appId || r.resource.id || "") : "";
    if (id) li.querySelector(".ap-id").textContent = String(id).slice(0, 8) + "…";
  }

  $("#applyHeading").textContent = "Simulation complete";
  $("#applySubLabel").textContent = "No tenant changes were made. Review the planned actions and scripts before applying for real.";
  renderApplyResult(result);
}
function renderApplyResult(result) {
  const s = result.summary || {};
  applyPreviewBackground($("#resultPreviewMount"), state.branding);
  $("#resultPreviewMount").innerHTML = buildPreviewCard(state.branding, new Set(orderedSelected()));
  const rows = [
    ["Tenant", s.tenantId],
    ["App (client) ID", s.appId && s.appId !== "—" ? String(s.appId).slice(0, 13) + "…" : "—"],
    ["User flow", s.flowName],
    ["Identity providers", (s.idps || []).length
      ? s.idps.join(", ") + (result.simulated ? "" : " — verify at live sign-in")
      : (s.flowName && s.flowName !== "—" ? "email + password only" : "—")],
    ["MFA / methods", (s.authMethods || []).length ? s.authMethods.join(", ") : "—"],
    ["Conditional Access", s.conditionalAccess ? "report-only policy" : "—"],
    ["Company branding", result.simulated
      ? (hasBrandingToWrite() ? "preview (simulated — not written)" : "—")
      : (s.branding && s.branding.applied ? "applied to sign-in page" : (hasBrandingToWrite() ? "see follow-ups below" : "—"))],
  ];
  $("#applySummary").innerHTML = rows.map(([k, v]) => `<div class="as-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v || "—"))}</span></div>`).join("");
  renderApplyGaps(result);
  $("#applyPreviewCol").hidden = false;
  $("#applyActions").hidden = false;
}

// Gap report on the final screen: merge analysis-time guidance with the actual
// outcome for each stable action kind so failed or unselected work cannot retain
// success-oriented validation text.
function renderApplyGaps(result) {
  const analysisGaps = (state.analysis?.gaps || []).map((g) => ({
    label: featureLabel(g.feature) + occurrenceSuffix(g, state.analysis?.gaps || []),
    reason: g.recommendation,
    availability: g.availability,
    notes: g.notes,
    docLink: g.docLink,
    manual: g.manual || null,
    followUpType: g.followUpType,
    actionKinds: g.actionKinds || [],
  }));
  const manual = (result.manualFollowUps || []).map((m) => ({
    kind: m.kind,
    label: m.label,
    status: m.status,
    reason: m.reason || "",
    manual: m.manual || null,
  }));
  const items = globalThis.PolicyTranslatorFollowUps.mergeApplyGapItems({
    analysisGaps,
    runtimeFollowUps: manual,
    applied: result.applied || [],
    simulated: result.simulated === true,
  });

  const box = $("#applyGaps");
  if (!items.length) {
    state.finalGapReport = "";
    box.hidden = true;
    return;
  }
  state.finalGapReport = buildFinalGapReport(items);
  $("#applyGapCount").textContent = `(${items.length})`;
  $("#applyGapList").innerHTML = items
    .map((x) => {
      const head = `<strong>${escapeHtml(x.label)}</strong>${x.reason ? `<span class="muted small"> — ${escapeHtml(x.reason)}</span>` : ""}`;
      const guidance = guidanceHtml(x.notes, x.docLink);
      if (!x.manual || !Array.isArray(x.manual.steps) || !x.manual.steps.length) return `<li>${head}${guidance}</li>`;
      const badge = x.manual.recreatable ? "" : ` <span class="gap-tag">no direct equivalent</span>`;
      const steps = x.manual.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      return `<li>${head}${badge}${guidance}
        <details class="gap-steps">
          <summary>${escapeHtml(x.manual.heading || "How to recreate this manually in External ID")}</summary>
          <p class="muted small">${escapeHtml(x.manual.note || "")}</p>
          <ol>${steps}</ol>
        </details></li>`;
    })
    .join("");
  box.hidden = false;
}

function markdownLine(value) {
  return String(value || "").replace(/\r?\n+/g, " ").trim();
}

function buildFinalGapReport(items) {
  const policyName = state.analysis?.policyName || "Policy migration";
  const lines = [
    `# Migration gap report — ${markdownLine(policyName)}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "This report includes analyzer gaps, apply failures, skipped steps, and required validation follow-ups from the completed migration run.",
    "",
    `## Summary`,
    "",
    `${items.length} item(s) require attention before the migration should be treated as complete.`,
    "",
  ];

  items.forEach((item) => {
    lines.push(`## ${markdownLine(item.label)}`, "");
    if (item.availability) lines.push(`**Migration classification:** ${markdownLine(item.availability)}`, "");
    if (item.reason) lines.push(`**Reason:** ${markdownLine(item.reason)}`, "");
    if (item.notes) lines.push(`**Analyzer guidance:** ${markdownLine(item.notes)}`, "");
    if (safeDocLink(item.docLink)) lines.push(`**Official guidance:** ${safeDocLink(item.docLink)}`, "");
    if (item.manual) {
      lines.push(`**Recreatable:** ${item.manual.recreatable ? "Yes" : "No direct equivalent"}`, "");
      if (item.manual.note) lines.push(markdownLine(item.manual.note), "");
      if (Array.isArray(item.manual.steps) && item.manual.steps.length) {
        lines.push("### Recommended steps", "");
        item.manual.steps.forEach((step, index) => lines.push(`${index + 1}. ${markdownLine(step)}`));
        lines.push("");
      }
    }
    lines.push("---", "");
  });
  return lines.join("\n");
}

// ─── Step 5: REAL apply (device-code sign-in + live Graph calls) ─────────────
async function startRealApply() {
  const tenantId = (state.config.tenantId || "").trim();
  if (!tenantId) { toast("Enter your Tenant ID in step 4 first."); showStep(4); return; }

  showStep(5);
  const orderedKinds = orderedSelected();
  $("#applyGrid").hidden = true;
  $("#applyActions").hidden = true;
  $("#applyPreviewCol").hidden = true;
  $("#applyGaps").hidden = true;
  $("#applyHeading").textContent = "Connect to your External ID tenant";
  $("#applySubLabel").textContent = "One-time admin sign-in, then we provision for real.";
  $("#deviceStatus").textContent = "Requesting a sign-in code…";
  $("#authPolicyNote").innerHTML = hasBrandingToWrite()
    ? "Some tenants with <strong>Security Defaults</strong> block device-code sign-in (AADSTS530035). Do not disable production security controls. The generated package can run supported scripted actions interactively, but Company Branding must be applied manually in the Entra admin center."
    : "Some tenants with <strong>Security Defaults</strong> block device-code sign-in (AADSTS530035). Do not disable production security controls. If blocked, download the generated package and run its interactive PowerShell scripts, or follow your tenant administrator's approved Conditional Access policy.";
  $("#deviceCode").textContent = "--------";
  $("#deviceAuth").hidden = false;

  let start;
  try {
    const res = await apiFetch("/api/auth/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        selectedKinds: orderedKinds,
        brandingIntent: hasBrandingToWrite(),
      }),
    });
    start = await res.json();
    if (!res.ok || start.error) throw new Error(start.error || "Failed to start sign-in.");
  } catch (err) { $("#deviceStatus").textContent = "Couldn't start sign-in: " + err.message; return; }

  state.auth = { sessionId: start.sessionId, cancelled: false };
  $("#deviceCode").textContent = start.userCode || "--------";
  if (start.verificationUri) {
    $("#deviceLink").href = start.verificationUri;
    $("#deviceLink").textContent = start.verificationUri.replace(/^https?:\/\//, "");
  }
  $("#deviceStatus").textContent = "Waiting for you to sign in…";
  pollAuth(Math.max(3, start.interval || 5) * 1000);
}

async function pollAuth(interval) {
  if (!state.auth || state.auth.cancelled) return;
  let data;
  try {
    const res = await apiFetch("/api/auth/poll", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.auth.sessionId }),
    });
    data = await res.json();
  } catch {
    $("#deviceStatus").textContent = "Network hiccup — retrying…";
    return void setTimeout(() => pollAuth(interval), interval);
  }
  if (data.status === "ready") {
    $("#deviceStatus").textContent = "Signed in ✓";
    $("#deviceAuth").hidden = true;
    return void runRealApply();
  }
  if (data.status === "error") {
    $("#deviceStatus").textContent = "Sign-in failed: " + (data.description || data.error);
    return;
  }
  setTimeout(() => pollAuth(interval), interval);
}

$("#cancelAuthBtn").addEventListener("click", () => {
  if (state.auth) state.auth.cancelled = true;
  $("#deviceAuth").hidden = true;
  showStep(4);
});
$("#copyCodeBtn").addEventListener("click", () => {
  const code = $("#deviceCode").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(code);
  toast("Code copied");
});

// ─── Branding import: read the SOURCE B2C tenant's real company branding ──────
$("#brandImportBtn").addEventListener("click", startBrandingImport);
$("#brandCopyCode").addEventListener("click", () => {
  const code = $("#brandDeviceCode").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(code);
  toast("Code copied");
});
$("#brandCancelImport").addEventListener("click", () => {
  if (state.brandingAuth) state.brandingAuth.cancelled = true;
  $("#brandDevice").hidden = true;
});

async function startBrandingImport() {
  const tenantId = $("#srcTenantId").value.trim();
  if (!tenantId) { toast("Enter your source B2C tenant ID or domain"); return; }
  $("#brandImportResult").hidden = true;
  $("#brandDevice").hidden = false;
  $("#brandDeviceStatus").textContent = "Requesting a sign-in code…";
  $("#brandDeviceCode").textContent = "—";

  let start;
  try {
    const res = await apiFetch("/api/branding/connect-start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    start = await res.json();
    if (!res.ok || start.error) throw new Error(start.error || "Failed to start sign-in.");
  } catch (err) { $("#brandDeviceStatus").textContent = "Couldn't start sign-in: " + err.message; return; }

  state.brandingAuth = { sessionId: start.sessionId, cancelled: false };
  $("#brandDeviceCode").textContent = start.userCode || "—";
  if (start.verificationUri) {
    $("#brandDeviceLink").href = start.verificationUri;
    $("#brandDeviceLink").textContent = start.verificationUri.replace(/^https?:\/\//, "");
  }
  $("#brandDeviceStatus").textContent = "Waiting for you to sign in…";
  pollBrandingAuth(Math.max(3, start.interval || 5) * 1000);
}

async function pollBrandingAuth(interval) {
  if (!state.brandingAuth || state.brandingAuth.cancelled) return;
  let data;
  try {
    const res = await apiFetch("/api/auth/poll", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.brandingAuth.sessionId }),
    });
    data = await res.json();
  } catch {
    $("#brandDeviceStatus").textContent = "Network hiccup — retrying…";
    return void setTimeout(() => pollBrandingAuth(interval), interval);
  }
  if (data.status === "ready") {
    $("#brandDeviceStatus").textContent = "Signed in ✓ — reading branding…";
    return void importBranding();
  }
  if (data.status === "error") {
    $("#brandDeviceStatus").textContent = "Sign-in failed: " + (data.description || data.error);
    return;
  }
  setTimeout(() => pollBrandingAuth(interval), interval);
}

async function importBranding() {
  let data;
  try {
    const res = await apiFetch("/api/branding/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.brandingAuth.sessionId }),
    });
    data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Import failed.");
  } catch (err) {
    $("#brandDeviceStatus").textContent = "Couldn't read branding: " + err.message;
    return;
  }
  $("#brandDevice").hidden = true;
  const b = data.branding || { hasBranding: false };
  applyImportedBranding(b);
}

function applyImportedBranding(b, showResult = true) {
  const result = $("#brandImportResult");
  result.hidden = !showResult;
  if (!b.hasBranding) {
    state.brandingImport = null;
    resetBrandingFromAnalysis();
    prefillBrandInputs();
    syncMigrationModeUi();
    result.className = "brand-import-result warn";
    result.innerHTML = state.migrationMode === "modernize"
      ? `No custom company branding found in that tenant. You can define a modernized look below.`
      : `No custom company branding was found. Closest 1:1 mode will leave Company Branding unchanged.`;
    updatePreview();
    return;
  }
  state.brandingImport = b;
  state.branding.bg = normalizeColor(b.backgroundColor, "#f3f6fb");
  state.branding.logo = b.bannerLogoUrl || b.squareLogoUrl || "";
  state.branding.backgroundImage = b.backgroundImageUrl || "";
  state.brandingDirty = new Set();
  prefillBrandInputs();
  const parts = [];
  if (b.bannerLogoUrl) parts.push("logo");
  if (b.backgroundColor) parts.push("background color");
  if (b.backgroundImageUrl) parts.push("background image");
  if (b.customCss) parts.push("custom CSS");
  result.className = "brand-import-result ok";
  result.innerHTML = `Imported your real branding (${escapeHtml(parts.join(", ") || "text")}). This will be applied to your External ID tenant on the last step.`;
  syncMigrationModeUi();
  updatePreview();
}

async function runRealApply() {
  const orderedKinds = orderedSelected();
  // Company branding runs server-side as an extra step when there's branding to
  // write — show it in the progress list so the user sees it happen.
  const displayKinds = hasBrandingToWrite() ? [...orderedKinds, "migrate-company-branding"] : orderedKinds;
  const kindLabel = (k) => CATALOG[k]?.label || (k === "migrate-company-branding" ? "Company branding" : k);
  $("#applyGrid").hidden = false;
  $("#applyHeading").innerHTML = `<span class="spin">⟳</span> Applying to External ID…`;
  $("#applySubLabel").textContent = "Provisioning your tenant via Microsoft Graph.";
  $("#applyActions").hidden = true;
  $("#applyPreviewCol").hidden = true;
  $("#applyGaps").hidden = true;

  const prog = $("#applyProgress");
  prog.innerHTML = displayKinds.map((k) =>
    `<li class="pending" data-kind="${k}"><span class="ap-icon">•</span><span>${escapeHtml(kindLabel(k))}</span><span class="ap-id"></span></li>`).join("");

  let result;
  try {
    const res = await apiFetch("/api/apply-real", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.auth.sessionId,
        selectedKinds: orderedKinds,
        selectedExtras: selectedModernizationExtras(),
        config: state.config,
        brandingIntent: hasBrandingToWrite(),
        brandingMode: state.migrationMode,
        branding: sourceBrandingPayload(),
        brandingManual: {
          enabled: state.migrationMode === "modernize" && state.brandingDirty.size > 0,
          ...(state.brandingDirty.has("bg") ? { bg: state.branding.bg } : {}),
          ...(state.brandingDirty.has("logo") ? { logo: state.branding.logo } : {}),
          ...(state.brandingDirty.has("backgroundImage") ? { backgroundImage: state.branding.backgroundImage } : {}),
          companyName: state.branding.companyName,
          ...(state.brandingDirty.has("accent") ? { accent: state.branding.accent } : {}),
        },
        brandingMeta: { companyName: state.branding.companyName, accent: state.branding.accent },
        analysisContext: {
          attributes: state.analysis?.context?.attributes || [],
          claims: state.analysis?.context?.claims || [],
          customAttributes: state.analysis?.context?.customAttributes || [],
        },
      }),
    });
    result = await res.json();
    if (!res.ok) throw new Error(result.error || "Apply failed.");
  } catch (err) {
    $("#applyHeading").textContent = "Apply failed";
    $("#applySubLabel").textContent = err.message;
    return;
  }

  const byKind = {}; (result.applied || []).forEach((a) => (byKind[a.kind] = a));
  for (const k of displayKinds) {
    const li = prog.querySelector(`li[data-kind="${k}"]`);
    if (!li) continue;
    li.classList.remove("pending"); li.classList.add("running");
    li.querySelector(".ap-icon").textContent = "⟳";
    await sleep(220);
    const r = byKind[k];
    const st = r ? r.status : "failed";
    const needsAttention = !r || st === "failed" || st === "manual" || st === "skipped" || r.requiresFollowUp;
    const cls = st === "failed" || !r ? "failed" : needsAttention ? "manual" : "done";
    const icon = st === "failed" || !r ? "×" : needsAttention ? "!" : "✓";
    li.classList.remove("running"); li.classList.add(cls);
    li.querySelector(".ap-icon").textContent = icon;
    const id = r && r.resource ? (r.resource.appId || r.resource.id || "") : "";
    if (id) li.querySelector(".ap-id").textContent = String(id).slice(0, 8) + "…";
    li.title = r?.message || (r ? "" : "The server did not return a result for this step.");
  }

  const failed = (result.applied || []).filter((a) => a.status === "failed").length;
  const followUps =
    (result.manualFollowUps || []).length +
    (state.analysis?.gaps || []).length;
  $("#applyHeading").textContent = failed || followUps ? "Apply completed with follow-ups" : "Applied to External ID";
  $("#applySubLabel").textContent = failed || followUps
    ? "Some steps need attention. Review every follow-up below before treating the migration as complete."
    : "Every selected step completed without a reported failure.";
  renderApplyResult(result);
}
// ─── Script viewer: inspect / download the equivalent deterministic package ──
let scriptFilesCache = [];
let scriptViewerMode = "scripts";

// Self-contained syntax highlighter (no external deps): tokenizes PowerShell
// and Markdown into spans coloured by proto.css. Sticky regexes are tried in
// order at each position; unmatched characters are emitted as escaped plain
// text. Good enough to give devs real, readable colour without a CDN.
function hlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const PS_RULES = [
  ["tok-comment", /<#[\s\S]*?#>/y, false],
  ["tok-comment", /#[^\n]*/y, false],
  ["tok-string", /"(?:`.|[^"])*"/y, false],
  ["tok-string", /'[^']*'/y, false],
  ["tok-var", /\$(?:\{[^}]*\}|[A-Za-z_][\w:.]*)/y, false],
  ["tok-kw", /\b(?:function|param|if|elseif|else|foreach|for|while|do|switch|try|catch|finally|throw|return|break|continue|begin|process|end|filter|in)\b/y, false],
  ["tok-cmdlet", /\b[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]+\b/y, false],
  ["tok-num", /\b\d+(?:\.\d+)?\b/y, false],
  ["tok-op", /-[a-zA-Z]+\b/y, false],
];
const MD_RULES = [
  ["tok-md-fence", /```[\s\S]*?```/y, false],
  ["tok-md-h", /#{1,6}[^\n]*/y, true],
  ["tok-md-hr", /(?:-{3,}|\*{3,})(?=\n|$)/y, true],
  ["tok-md-quote", />[^\n]*/y, true],
  ["tok-md-list", /(?:[-*]|\d+\.)\s/y, true],
  ["tok-md-code", /`[^`\n]+`/y, false],
  ["tok-md-bold", /\*\*[^*\n]+\*\*/y, false],
  ["tok-md-link", /\[[^\]\n]+\]\([^)\n]+\)/y, false],
];
function highlightCode(code, lang) {
  const rules = lang === "markdown" ? MD_RULES : lang === "powershell" ? PS_RULES : null;
  if (!rules) return hlEscape(code);
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const atLineStart = i === 0 || code[i - 1] === "\n";
    let matched = false;
    for (const [cls, re, lineStart] of rules) {
      if (lineStart && !atLineStart) continue;
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        out += `<span class="${cls}">${hlEscape(m[0])}</span>`;
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) { out += hlEscape(code[i]); i++; }
  }
  return out;
}

async function openScriptViewer() {
  if (!state.rawJson) { toast("Upload a policy first."); return; }
  scriptViewerMode = "scripts";
  $("#scriptModal").classList.remove("report-mode");
  $("#scriptTitle").textContent = "Equivalent scripts";
  $("#scriptIntro").textContent = "The exact deterministic package that matches these steps — the same code the scripts version generates. Inspect it, or download the full package to run it yourself.";
  $("#scriptDownloadBtn").textContent = "Download package (.zip)";
  const backdrop = $("#scriptBackdrop");
  $("#scriptFiles").innerHTML = `<div class="muted small" style="padding:10px;">Generating…</div>`;
  $("#scriptContent").textContent = "";
  $("#scriptCurrentName").textContent = "—";
  backdrop.hidden = false;
  try {
    const res = await apiFetch("/api/scripts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: state.rawJson,
        config: state.config,
        selectedKinds: orderedSelected(),
        brandingIntent: hasBrandingToWrite(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.files) throw new Error((data.errors && data.errors[0] && data.errors[0].message) || "Could not generate scripts.");
    scriptFilesCache = data.files;
    renderScriptFileList();
    if (scriptFilesCache.length) showScriptFile(0);
  } catch (err) {
    $("#scriptFiles").innerHTML = "";
    $("#scriptContent").textContent = String(err.message || err);
  }
}

function openGapReportPreview() {
  if (!state.finalGapReport) {
    toast("There is no gap report for this run.");
    return;
  }
  scriptViewerMode = "gap-report";
  scriptFilesCache = [{
    name: "gap-report.md",
    content: state.finalGapReport,
    kind: "doc",
  }];
  $("#scriptModal").classList.add("report-mode");
  $("#scriptTitle").textContent = "Migration gap report";
  $("#scriptIntro").textContent = "A complete report of every analyzer gap, apply failure, skipped step, and required validation follow-up from this run.";
  $("#scriptDownloadBtn").textContent = "Download report (.md)";
  $("#scriptFiles").innerHTML = "";
  showScriptFile(0);
  $("#scriptBackdrop").hidden = false;
  $("#scriptCloseX").focus();
  sendClientTelemetry("gap_report_previewed", state.analysis?.gaps?.length || 0);
}
const ICON_DOC = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.75h4.5L12.25 5.5v8.75H4z"/><path d="M8.25 1.75V5.5h3.75"/></svg>';
const ICON_SCRIPT = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5l3 3-3 3"/><path d="M8.5 11h4"/></svg>';
function renderScriptFileList() {
  if (scriptViewerMode === "gap-report") {
    $("#scriptFiles").innerHTML = "";
    return;
  }
  $("#scriptFiles").innerHTML = scriptFilesCache
    .map((f, i) => `<button type="button" class="script-file ${i === 0 ? "active" : ""}" data-idx="${i}">
      <span class="sf-icon">${f.kind === "doc" ? ICON_DOC : ICON_SCRIPT}</span><span class="sf-name">${escapeHtml(f.name)}</span></button>`)
    .join("");
}
function showScriptFile(idx) {
  const f = scriptFilesCache[idx];
  if (!f) return;
  const code = $("#scriptContent");
  code.dataset.raw = f.content;
  const lang = /\.ps1$/i.test(f.name) ? "powershell" : /\.md$/i.test(f.name) ? "markdown" : "";
  code.innerHTML = highlightCode(f.content, lang);
  $("#scriptCurrentName").textContent = f.name;
  $$("#scriptFiles .script-file").forEach((b) => b.classList.toggle("active", Number(b.dataset.idx) === idx));
}
function closeScriptViewer() { $("#scriptBackdrop").hidden = true; }

$$(".js-view-scripts").forEach((b) => b.addEventListener("click", openScriptViewer));
$("#gapPreviewBtn").addEventListener("click", openGapReportPreview);
$("#gapDownloadBtn").addEventListener("click", downloadGapReport);
$("#scriptFiles").addEventListener("click", (e) => {
  const btn = e.target.closest(".script-file");
  if (btn) showScriptFile(Number(btn.dataset.idx));
});
$("#scriptCloseX").addEventListener("click", closeScriptViewer);
$("#scriptClose").addEventListener("click", closeScriptViewer);
$("#scriptBackdrop").addEventListener("click", (e) => { if (e.target === $("#scriptBackdrop")) closeScriptViewer(); });
$("#scriptCopyBtn").addEventListener("click", async () => {
  const raw = $("#scriptContent").dataset.raw || $("#scriptContent").textContent;
  try { await navigator.clipboard.writeText(raw); toast("Copied to clipboard."); }
  catch { toast("Copy failed — select and copy manually."); }
});

function downloadGapReport() {
  if (!state.finalGapReport) {
    toast("There is no gap report for this run.");
    return;
  }
  const blob = new Blob([state.finalGapReport], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (state.analysis?.policyName || "policy").replace(/[^a-zA-Z0-9-_]/g, "_");
  a.href = url;
  a.download = `gap-report-${safeName}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  sendClientTelemetry("gap_report_downloaded", state.analysis?.gaps?.length || 0);
}

$("#scriptDownloadBtn").addEventListener("click", async () => {
  if (scriptViewerMode === "gap-report") {
    downloadGapReport();
    return;
  }
  try {
    const res = await apiFetch("/api/scripts-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        json: state.rawJson,
        config: state.config,
        selectedKinds: orderedSelected(),
        brandingIntent: hasBrandingToWrite(),
      }),
    });
    if (!res.ok) throw new Error("Download failed.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `migration-package-${(state.analysis?.policyName || "policy").replace(/[^a-zA-Z0-9-_]/g, "_")}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast(String(err.message || err)); }
});

$("#restartBtn").addEventListener("click", () => {
  state.analysis = null; state.selected = new Set(); state.config = {}; state.auth = null;
  state.brandingImport = null;
  if (state.brandingAuth) state.brandingAuth.cancelled = true;
  state.brandingAuth = null;
  state.branding = { companyName: "", accent: "#0067b8", logo: "", bg: "#f3f6fb" };
  setBrandControlsLocked(false);
  $("#deviceAuth").hidden = true; $("#applyGrid").hidden = false; $("#applyGaps").hidden = true;
  $("#brandDevice") && ($("#brandDevice").hidden = true);
  $("#brandImportResult") && ($("#brandImportResult").hidden = true);
  $("#jsonInput").value = ""; showStep(1);
});

// ─── Sample policy (for the "Try a sample" link) ─────────────────────────────
const SAMPLE_POLICY = {
  policyName: "B2C_1A_signup_signin_social_mfa",
  features: [
    { name: "signUp_auth_emailPassword", description: "Email + password sign-up", reason: "Local account sign-up detected", recommendation: "Supported via user flow.", externalIdAvailability: "Available" },
    { name: "signIn_auth_emailPassword", description: "Email + password sign-in", reason: "Local account sign-in detected", recommendation: "Supported via user flow.", externalIdAvailability: "Available" },
    { name: "signIn_idp_google", description: "Google social sign-in", reason: "Google IdP detected", recommendation: "Supported.", externalIdAvailability: "Available" },
    { name: "signIn_idp_facebook", description: "Facebook social sign-in", reason: "Facebook IdP detected", recommendation: "Supported.", externalIdAvailability: "Available" },
    { name: "signIn_otp_email", description: "Email one-time passcode", reason: "Email OTP detected", recommendation: "Supported.", externalIdAvailability: "Available" },
    { name: "signIn_otp_phoneSms", description: "SMS one-time passcode", reason: "Phone/SMS detected", recommendation: "Supported as MFA.", externalIdAvailability: "Available" },
    { name: "passwordReset_recovery", description: "Self-service password reset", reason: "Password reset journey detected", recommendation: "Supported.", externalIdAvailability: "Available" },
    { name: "signIn_security_conditionalAccess", description: "Require MFA", reason: "MFA requirement detected", recommendation: "Supported via Conditional Access.", externalIdAvailability: "Available" },
    { name: "global_token_claimsMapping", description: "Custom claims in token", reason: "Claims mapping detected", recommendation: "Supported.", externalIdAvailability: "Available" },
    { name: "global_ux_tenantBranding", description: "Company branding", reason: "ContentDefinition branding detected", recommendation: "Company branding supported.", externalIdAvailability: "Available" },
    { name: "passwordReset_security_passwordComplexity", description: "Custom password complexity rules", reason: "Regex-based password predicates detected", recommendation: "No automated equivalent — set password rules manually in the Entra admin center.", externalIdAvailability: "Available" },
    { name: "global_ux_customHtmlJs", description: "Custom HTML/JavaScript UI", reason: "Custom page content (HTML/JS) detected", recommendation: "Custom HTML/JS pages aren't supported — rebuild with Company Branding + custom CSS.", externalIdAvailability: "NotAvailable" },
  ],
};

$("#telemetryToggle").addEventListener("change", (event) => {
  event.target.checked = saveTelemetryPreference(event.target.checked);
  void syncTelemetryPreference();
});

void syncTelemetryPreference();
showStep(1);
