/* Policy Translator — front-end wizard logic */

const state = {
  rawJson: null,        // parsed analyzer JSON
  analysis: null,       // /api/analyze response
  config: {},           // user-entered config
  generated: null,      // /api/generate response
};

const FILE_DESCRIPTIONS = {
  "01-create-native-app.ps1": "Registers the native app + service principal",
  "02-create-user-flow.ps1": "Creates the sign-up / sign-in user flow with attributes",
  "03-smoke-test-native-auth.ps1": "Smoke-tests the native auth endpoint",
  "04-add-google-idp.ps1": "Configures Google as an identity provider",
  "05-add-facebook-idp.ps1": "Configures Facebook as an identity provider",
  "07-enable-email-otp.ps1": "Enables email one-time-passcode",
  "08-claims-mapping-policy.ps1": "Applies the claims mapping policy",
  "09-enable-sspr.ps1": "Enables self-service password reset",
  "11-enable-sms-mfa.ps1": "Enables SMS one-time-passcode as an MFA method",
  "12-create-ca-policy.ps1": "Creates a Conditional Access policy requiring MFA (report-only)",
  "13-enable-passkey.ps1": "Enables passkey (FIDO2) as an MFA method for password-based accounts",
  "14-create-custom-attributes.ps1": "Creates custom user attributes and adds them to the sign-up flow",
  "README.md": "Setup guide and run order",
  "gap-report.md": "Features needing manual work",
};

// What each script does in the tenant + the Graph delegated scopes it requests.
// Scopes mirror the Connect-MgGraph calls in src/generators/templates/*.ps1.
const SCRIPT_META = {
  "01-create-native-app.ps1": { action: "Register a native app + service principal", scopes: ["Application.ReadWrite.All"] },
  "02-create-user-flow.ps1": { action: "Create the sign-up / sign-in user flow", scopes: ["EventListener.ReadWrite.All", "IdentityUserFlow.ReadWrite.All"] },
  "03-smoke-test-native-auth.ps1": { action: "Verify the app-to-flow binding and run a read-only native-auth endpoint check", scopes: ["Organization.Read.All", "EventListener.Read.All"] },
  "04-add-google-idp.ps1": { action: "Create a Google identity provider and attach it to the user flow", scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All", "Organization.Read.All"] },
  "05-add-facebook-idp.ps1": { action: "Create a Facebook identity provider and attach it to the user flow", scopes: ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All"] },
  "07-enable-email-otp.ps1": { action: "Enable email one-time-passcode as an authentication method", scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "08-claims-mapping-policy.ps1": { action: "Create a claims mapping policy and assign it to the app", scopes: ["Policy.ReadWrite.ApplicationConfiguration", "Application.ReadWrite.All"] },
  "09-enable-sspr.ps1": { action: "Enable self-service password reset (and its email OTP method)", scopes: ["EventListener.ReadWrite.All", "Policy.ReadWrite.AuthenticationMethod"] },
  "11-enable-sms-mfa.ps1": { action: "Enable SMS one-time-passcode as an MFA method", scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "12-create-ca-policy.ps1": { action: "Create a Conditional Access policy requiring MFA (report-only)", scopes: ["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"] },
  "13-enable-passkey.ps1": { action: "Enable passkey (FIDO2) as an authentication method", scopes: ["Policy.ReadWrite.AuthenticationMethod"] },
  "14-create-custom-attributes.ps1": { action: "Create custom user attributes and add them to the sign-up flow", scopes: ["IdentityUserFlow.ReadWrite.All", "EventListener.ReadWrite.All"] },
};

const SCOPE_DESCRIPTIONS = {
  "Application.ReadWrite.All": "create and update app registrations",
  "IdentityProvider.ReadWrite.All": "create and update identity providers",
  "EventListener.ReadWrite.All": "create and update user flows",
  "IdentityUserFlow.ReadWrite.All": "create and update custom user attributes",
  "Policy.ReadWrite.AuthenticationMethod": "configure authentication methods (email OTP, SMS, passkey)",
  "Policy.ReadWrite.ConditionalAccess": "create and update Conditional Access policies",
  "Policy.Read.All": "read existing Conditional Access policies before reuse",
  "Policy.ReadWrite.ApplicationConfiguration": "configure claims mapping policies",
  "Organization.Read.All": "read tenant details (used to discover your domain)",
  "EventListener.Read.All": "verify the application is bound to the expected user flow",
};

// Least-privilege admin role that can consent to each scope.
const SCOPE_ROLES = {
  "Application.ReadWrite.All": "Application Administrator",
  "Policy.ReadWrite.ApplicationConfiguration": "Application Administrator",
  "IdentityProvider.ReadWrite.All": "External Identity Provider Administrator",
  "EventListener.ReadWrite.All": "External ID user-flow administrator",
  "IdentityUserFlow.ReadWrite.All": "External ID user-flow administrator",
  "Policy.ReadWrite.AuthenticationMethod": "Authentication Policy Administrator",
  "Policy.ReadWrite.ConditionalAccess": "Conditional Access Administrator",
  "Policy.Read.All": "Conditional Access Administrator",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showStep(n) {
  for (let i = 1; i <= 4; i++) {
    $(`#panel-${i}`).hidden = i !== n;
  }
  $$(".stepper li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), 2200);
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

function occurrenceSuffix(item, collection) {
  if (!item?.occurrence && !item?.featureOccurrence) return "";
  return ` · journey ${item.occurrence || item.featureOccurrence}`;
}

// ─── Step 1: Upload ───────────────────────────────────────────────────────────

const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

$("#browseBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) readFile(e.target.files[0]);
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

$("#pasteToggle").addEventListener("click", (e) => {
  e.preventDefault();
  const pa = $("#pasteArea");
  pa.hidden = !pa.hidden;
});

$("#analyzePasteBtn").addEventListener("click", () => {
  const text = $("#jsonInput").value.trim();
  if (!text) { showUploadError("Paste some JSON first."); return; }
  parseAndAnalyze(text);
});

$("#sampleBtn").addEventListener("click", (e) => {
  e.preventDefault();
  parseAndAnalyze(JSON.stringify(SAMPLE_POLICY));
});

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => parseAndAnalyze(reader.result);
  reader.onerror = () => showUploadError("Could not read that file.");
  reader.readAsText(file);
}

function showUploadError(msg, details) {
  const el = $("#uploadError");
  let html = `<strong>${escapeHtml(msg)}</strong>`;
  if (details && details.length) {
    html += "<ul>" + details.map((d) => `<li>[${escapeHtml(d.field)}] ${escapeHtml(d.message)}</li>`).join("") + "</ul>";
  }
  el.innerHTML = html;
  el.hidden = false;
}

async function parseAndAnalyze(text) {
  $("#uploadError").hidden = true;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    showUploadError("That's not valid JSON. Check for a missing brace or trailing comma.");
    return;
  }
  state.rawJson = parsed;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: parsed }),
    });
    const data = await res.json();
    if (!data.valid) {
      showUploadError("The Analyzer JSON didn't pass validation:", data.errors);
      return;
    }
    state.analysis = data;
    renderReview(data);
    showStep(2);
  } catch (err) {
    showUploadError("Server error: " + err.message);
  }
}

// ─── Step 2: Review ───────────────────────────────────────────────────────────

function renderReview(data) {
  $("#policyNameLabel").textContent = data.policyName;
  $("#analyzerReadinessLabel").textContent = data.readiness.analyzerScore
    ? `Policy Analyzer platform readiness: ${data.readiness.analyzerScore}`
    : "Policy Analyzer platform readiness: not provided";

  // Gauge
  const pct = data.readiness.percent;
  const gauge = $("#gauge");
  const color = pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--red)";
  gauge.style.background = `conic-gradient(${color} ${pct}%, var(--line) ${pct}%)`;
  $("#gaugePct").textContent = pct + "%";
  $("#readinessScore").textContent = data.readiness.score;

  // Stat cards
  const r = data.readiness;
  $("#statRow").innerHTML = `
    <div class="stat-card"><div class="num">${r.total}</div><div class="lbl">Features detected</div></div>
    <div class="stat-card green"><div class="num">${r.ready}</div><div class="lbl">Ready to migrate</div></div>
    <div class="stat-card amber"><div class="num">${r.needsWork}</div><div class="lbl">Need attention</div></div>
    <div class="stat-card brand"><div class="num">${data.steps.length}</div><div class="lbl">Scripts generated</div></div>
  `;

  // Feature table
  const tbody = $("#featureTable tbody");
  tbody.innerHTML = data.features.map((f) => `
    <tr>
      <td><span class="feat-name">${escapeHtml(f.name)}</span>${occurrenceSuffix(f, data.features) ? `<span class="muted small">${escapeHtml(occurrenceSuffix(f, data.features))}</span>` : ""}<br><span class="muted small">${escapeHtml(f.description)}</span>${guidanceHtml(f.guidance, f.docLink)}</td>
      <td><span class="pill ${f.status}">${escapeHtml(f.statusLabel)}</span></td>
    </tr>
  `).join("");

  // Step list
  $("#stepList").innerHTML = data.steps.map((s, i) => {
    const fileName = STEP_FILES[s.kind] || s.kind;
    const desc = FILE_DESCRIPTIONS[fileName] || s.kind;
    return `
      <li>
        <span class="step-badge">${String(i + 1).padStart(2, "0")}</span>
        <span class="step-info"><strong>${escapeHtml(fileName)}</strong><span>${escapeHtml(desc)}</span></span>
      </li>`;
  }).join("");

  // Gaps
  const gapList = $("#gapList");
  $("#gapCount").textContent = data.gaps.length ? `(${data.gaps.length})` : "";
  if (data.gaps.length === 0) {
    gapList.innerHTML = `<li class="empty">No manual work — everything detected is automatable.</li>`;
  } else {
    gapList.innerHTML = data.gaps.map((g) => `
      <li><strong>${escapeHtml(g.feature + occurrenceSuffix(g, data.gaps))}</strong>${escapeHtml(g.recommendation)}${guidanceHtml(g.notes, g.docLink)}</li>
    `).join("");
  }

  // Warnings
  const warnEl = $("#reviewWarnings");
  if (data.warnings && data.warnings.length) {
    warnEl.innerHTML = `<strong>${data.warnings.length} note(s) during validation:</strong><ul>` +
      data.warnings.slice(0, 6).map((w) => `<li>${escapeHtml(w.message)}</li>`).join("") + "</ul>";
    warnEl.hidden = false;
  } else {
    warnEl.hidden = true;
  }
}

$("#backTo1").addEventListener("click", () => showStep(1));
$("#goTo3").addEventListener("click", () => { renderConfigForm(state.analysis.requiredInputs); showStep(3); });

// ─── Step 3: Configure ────────────────────────────────────────────────────────

function renderConfigForm(inputs) {
  const form = $("#configForm");
  const groups = {};
  for (const f of inputs) {
    (groups[f.group] = groups[f.group] || []).push(f);
  }

  let html = "";
  for (const [group, fields] of Object.entries(groups)) {
    html += `<div class="config-group-title">${escapeHtml(group)}</div>`;
    for (const f of fields) {
      const inputType = f.type === "password" ? "password" : "text";
      html += `
        <div class="field" data-key="${f.key}" data-type="${f.type}" data-required="${f.required}">
          <label>${escapeHtml(f.label)}${f.required ? '<span class="req">*</span>' : ""}</label>
          <input type="${inputType}" id="cfg-${f.key}" placeholder="${escapeHtml(f.placeholder)}" />
          <div class="help">${escapeHtml(f.help)}</div>
          <div class="field-error"></div>
        </div>`;
    }
  }
  form.innerHTML = html;
}

function validateField(fieldEl) {
  const key = fieldEl.dataset.key;
  const type = fieldEl.dataset.type;
  const required = fieldEl.dataset.required === "true";
  const input = fieldEl.querySelector("input");
  const errEl = fieldEl.querySelector(".field-error");
  const val = input.value.trim();

  let error = "";
  if (required && !val) {
    error = "This field is required.";
  } else if (val && type === "guid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
    error = "Must be a valid GUID (e.g. 00000000-0000-0000-0000-000000000000).";
  } else if (val && type === "url" && !/^https?:\/\/.+/i.test(val)) {
    error = "Must be a valid URL starting with http(s)://.";
  }

  fieldEl.classList.toggle("show-error", !!error);
  input.classList.toggle("invalid", !!error);
  errEl.textContent = error;
  return !error;
}

$("#configForm").addEventListener("blur", (e) => {
  if (e.target.tagName === "INPUT") validateField(e.target.closest(".field"));
}, true);

$("#backTo2").addEventListener("click", () => showStep(2));

$("#generateBtn").addEventListener("click", () => {
  const fields = $$("#configForm .field");
  let allValid = true;
  const config = {};
  for (const f of fields) {
    if (!validateField(f)) allValid = false;
    const input = f.querySelector("input");
    if (input.value.trim()) config[f.dataset.key] = input.value.trim();
  }
  if (!allValid) { toast("Please fix the highlighted fields."); return; }

  state.config = config;
  openConsentModal();
});

// ─── Consent / permissions gate ───────────────────────────────────────────────

function selectedScriptFiles() {
  const steps = (state.analysis && state.analysis.steps) || [];
  return steps.map((s) => STEP_FILES[s.kind] || s.kind).filter((f) => SCRIPT_META[f]);
}

function openConsentModal() {
  const files = selectedScriptFiles();

  $("#consentActions").innerHTML = files
    .map((f) => `<li><code>${escapeHtml(f)}</code> &mdash; ${escapeHtml(SCRIPT_META[f].action)}</li>`)
    .join("");

  const scopeSet = new Set();
  files.forEach((f) => SCRIPT_META[f].scopes.forEach((sc) => scopeSet.add(sc)));
  const scopes = [...scopeSet].sort();
  $("#consentScopes").innerHTML = scopes.length
    ? scopes.map((sc) => `<li><code>${escapeHtml(sc)}</code> &mdash; ${escapeHtml(SCOPE_DESCRIPTIONS[sc] || "")}</li>`).join("")
    : `<li class="muted">No tenant-write permissions required.</li>`;

  const roleSet = new Set();
  scopes.forEach((sc) => { if (SCOPE_ROLES[sc]) roleSet.add(SCOPE_ROLES[sc]); });
  const roles = [...roleSet].sort();
  const rolesHtml = roles.length
    ? roles.map((r) => `<li>${escapeHtml(r)}</li>`).join("") +
      `<li class="muted small">A single <strong>Global Administrator</strong> can consent to all of the above.</li>`
    : `<li class="muted">Any admin who can sign in to the tenant.</li>`;
  $("#consentRoles").innerHTML = rolesHtml;

  $("#consentAgree").checked = false;
  $("#consentProceed").disabled = true;
  $("#consentBackdrop").hidden = false;
}

function closeConsentModal() {
  $("#consentBackdrop").hidden = true;
}

$("#consentAgree").addEventListener("change", (e) => {
  $("#consentProceed").disabled = !e.target.checked;
});
$("#consentCancel").addEventListener("click", closeConsentModal);
$("#consentCancelX").addEventListener("click", closeConsentModal);
$("#consentBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "consentBackdrop") closeConsentModal();
});
$("#consentProceed").addEventListener("click", runGeneration);

async function runGeneration() {
  const btn = $("#consentProceed");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: state.rawJson, config: state.config }),
    });
    const data = await res.json();
    if (data.errors) { toast("Generation failed."); console.error(data.errors); return; }
    state.generated = data;
    closeConsentModal();
    renderResults(data);
    showStep(4);
  } catch (err) {
    toast("Server error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = "I understand &mdash; generate";
  }
}

// ─── Step 4: Results ──────────────────────────────────────────────────────────

function renderResults(data) {
  $("#resultPolicyLabel").textContent = data.policyName;

  const allFiles = [
    ...data.scripts,
    { filename: "README.md", content: data.readme },
  ];
  if (data.gapReport) allFiles.push({ filename: "gap-report.md", content: data.gapReport });

  // Run order = the ps1 scripts in order (each row copyable)
  const scripts = data.scripts;
  $("#runOrderList").innerHTML = scripts.map((s) => {
    const cmd = `./${s.filename}`;
    return `<li><code>${escapeHtml(cmd)}</code>` +
      `<button class="btn-copy-cmd" type="button" data-cmd="${escapeHtml(cmd)}" title="Copy command">Copy</button></li>`;
  }).join("");
  $("#runOrderList").onclick = (e) => {
    const btn = e.target.closest(".btn-copy-cmd");
    if (!btn) return;
    navigator.clipboard.writeText(btn.dataset.cmd).then(() => toast("Command copied."));
  };
  $("#copyAllCmds").onclick = () => {
    const all = scripts.map((s) => `./${s.filename}`).join("\n");
    navigator.clipboard.writeText(all).then(() => toast("All commands copied."));
  };

  // File cards
  $("#fileList").innerHTML = allFiles.map((f) => {
    const isPs = f.filename.endsWith(".ps1");
    const iconClass = isPs ? "ps" : "md";
    const iconChar = isPs ? "&#62;_" : "&#9776;";
    const desc = FILE_DESCRIPTIONS[f.filename] || "";
    return `
      <div class="file-card" data-file="${escapeHtml(f.filename)}">
        <div class="fc-left">
          <div class="file-icon ${iconClass}">${iconChar}</div>
          <div>
            <div class="fname">${escapeHtml(f.filename)}</div>
            <div class="fdesc">${escapeHtml(desc)}</div>
          </div>
        </div>
        <div class="file-actions">
          <button class="btn-secondary small view-btn" type="button">View</button>
          <button class="btn-ghost small dl-btn" type="button">Download</button>
        </div>
      </div>`;
  }).join("");

  // Wire per-file buttons
  $$("#fileList .file-card").forEach((card) => {
    const fname = card.dataset.file;
    const file = allFiles.find((f) => f.filename === fname);
    card.querySelector(".view-btn").addEventListener("click", () => openModal(fname, file.content));
    card.querySelector(".dl-btn").addEventListener("click", () => downloadText(fname, file.content));
  });
}

$("#downloadZipBtn").addEventListener("click", async () => {
  const btn = $("#downloadZipBtn");
  btn.disabled = true; btn.textContent = "Zipping…";
  try {
    const res = await fetch("/api/generate-zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: state.rawJson, config: state.config }),
    });
    if (!res.ok) { toast("Zip failed."); return; }
    const blob = await res.blob();
    const name = (state.generated.policyName || "policy").replace(/[^a-zA-Z0-9-_]/g, "_");
    triggerBlobDownload(blob, `migration-package-${name}.zip`);
    toast("Download started.");
  } catch (err) {
    toast("Server error: " + err.message);
  } finally {
    btn.disabled = false; btn.innerHTML = "&#8681; Download all (.zip)";
  }
});

$("#restartBtn").addEventListener("click", () => {
  state.rawJson = state.analysis = state.generated = null;
  state.config = {};
  fileInput.value = "";
  $("#jsonInput").value = "";
  showStep(1);
});

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(title, content) {
  $("#modalTitle").textContent = title;
  const codeEl = $("#modalCode");
  if (title.toLowerCase().endsWith(".ps1")) {
    codeEl.innerHTML = highlightPowerShell(content);
  } else {
    codeEl.textContent = content;
  }
  $("#modalBackdrop").hidden = false;
  $("#copyScriptBtn").onclick = () => {
    navigator.clipboard.writeText(content).then(() => toast("Copied to clipboard."));
  };
}

// Lightweight PowerShell syntax highlighter (VS Code Dark palette). Tokenizes the
// RAW source so string/comment delimiters are intact, and HTML-escapes at emit
// time so the code is safe to inject as innerHTML.
const PS_KEYWORDS = new Set([
  "try", "catch", "finally", "if", "else", "elseif", "foreach", "for", "while",
  "switch", "function", "return", "exit", "param", "begin", "process", "end",
  "throw", "break", "continue", "in", "do", "filter", "using", "class",
]);

function highlightPowerShell(code) {
  // Groups: 1 comment, 2 dq-string, 3 sq-string, 4 variable, 5 cmdlet (Verb-Noun),
  // 6 parameter/operator (-word), 7 number, 8 identifier.
  const re = /(#[^\n]*)|("(?:[^"`]|`.)*")|('(?:[^']|'')*')|(\$[A-Za-z_][\w:]*)|([A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9]*)|(-[A-Za-z][A-Za-z0-9]*)|(\b\d+\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    const tok = m[0];
    let cls = null;
    if (m[1]) cls = "tok-comment";
    else if (m[2] || m[3]) cls = "tok-string";
    else if (m[4]) cls = "tok-var";
    else if (m[5]) cls = "tok-cmdlet";
    else if (m[6]) cls = "tok-param";
    else if (m[7]) cls = "tok-number";
    else if (m[8]) cls = PS_KEYWORDS.has(tok.toLowerCase()) ? "tok-keyword" : null;
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    last = m.index + tok.length;
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}
$("#closeModalBtn").addEventListener("click", () => ($("#modalBackdrop").hidden = true));
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target.id === "modalBackdrop") $("#modalBackdrop").hidden = true; });

// ─── Downloads ────────────────────────────────────────────────────────────────

function downloadText(filename, content) {
  triggerBlobDownload(new Blob([content], { type: "text/plain" }), filename);
}
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Step kind → filename map (mirror of scriptGenerator) ─────────────────────

const STEP_FILES = {
  "create-native-app": "01-create-native-app.ps1",
  "create-user-flow-emailpassword": "02-create-user-flow.ps1",
  "smoke-test-native-auth": "03-smoke-test-native-auth.ps1",
  "add-google-idp": "04-add-google-idp.ps1",
  "add-facebook-idp": "05-add-facebook-idp.ps1",
  "enable-sms-mfa": "11-enable-sms-mfa.ps1",
  "create-ca-policy": "12-create-ca-policy.ps1",
  "enable-passkey": "13-enable-passkey.ps1",
  "enable-email-otp": "07-enable-email-otp.ps1",
  "claims-mapping-policy": "08-claims-mapping-policy.ps1",
  "enable-sspr": "09-enable-sspr.ps1",
  "create-custom-attributes": "14-create-custom-attributes.ps1",
};

// ─── Sample policy (for the "Try a sample" link) ──────────────────────────────

const SAMPLE_POLICY = {
  policyName: "B2C_1A_DemoSignUpSignIn",
  features: [
    { name: "signUp_auth_emailPassword", description: "Email and password sign-up", reason: "Self-asserted sign-up technical profile detected", recommendation: "Supported in External ID.", externalIdAvailability: "Available" },
    { name: "signIn_auth_emailPassword", description: "Email and password sign-in", reason: "Self-asserted sign-in technical profile detected", recommendation: "Supported in External ID.", externalIdAvailability: "Available" },
    { name: "signIn_idp_google", description: "Google social identity provider", reason: "Identity provider detected: Google (OAuth2)", recommendation: "Configure Google IdP in External ID.", externalIdAvailability: "Available" },
    { name: "signIn_idp_facebook", description: "Facebook social identity provider", reason: "Identity provider detected: Facebook (OAuth2)", recommendation: "Configure Facebook IdP in External ID.", externalIdAvailability: "Available" },
    { name: "signIn_idp_partnerIdp", description: "Custom OIDC identity provider", reason: "Identity provider detected: Contoso Partner (OpenIdConnect)", recommendation: "Configure manually in External ID and attach it to the user flow.", externalIdAvailability: "Available" },
    { name: "signIn_otp_email", description: "MFA via email OTP", reason: "Email OTP technical profile detected", recommendation: "Use built-in email OTP MFA.", externalIdAvailability: "Available" },
    { name: "global_token_claimsMapping", description: "Claims partner mapping", reason: "PartnerClaimType mappings detected", recommendation: "Use claims mapping policy.", externalIdAvailability: "Available" },
    { name: "signUp_attributes_custom", description: "Custom extension attributes", reason: "Extension attributes detected in claims schema (city, jobTitle)", recommendation: "Use custom attributes.", externalIdAvailability: "Available" },
    { name: "global_infra_restApiValidate", description: "REST API validation", reason: "REST API technical profile in validation", recommendation: "Use custom auth extensions.", externalIdAvailability: "Partial" },
    { name: "signIn_hrd_defaultIdp", description: "Home realm discovery", reason: "Default IdP selection detected", recommendation: "Needs custom auth extensions.", externalIdAvailability: "NeedsExtensions" },
  ],
};
