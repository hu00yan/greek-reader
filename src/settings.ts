// Settings modal: bring-your-own-key provider profiles + cost caps.
// Persisted to localStorage keys "greek-reader.llm.profiles" (profile array
// with a default flag) and "greek-reader.llm" (template, caps, active id).
//
// Anti-runaway design note shown here and enforced in llm.ts: every AI call
// originates from ONE explicit user click; there is no bulk/loop API.
//
// All DOM built with createElement/textContent — no innerHTML anywhere.

import {
  CAP_LIMITS,
  DATA_NOTE,
  DEFAULT_BASE_URL,
  DEFAULT_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  loadCaps,
  loadProfiles,
  loadTemplate,
  newDefaultProfile,
  newId,
  saveCaps,
  saveProfiles,
  saveTemplate,
  setActiveProfile,
  type Effort,
  type Profile,
  type Protocol,
} from "./llm";
import { callLLM } from "./llm";

const PROTOCOLS: Protocol[] = ["openai", "anthropic", "responses"];
const EFFORTS: Array<{ v: Effort; label: string }> = [
  { v: "", label: "default" },
  { v: "low", label: "low" },
  { v: "medium", label: "medium" },
  { v: "high", label: "high" },
];

let modalOpen = false;

interface SettingsOptions {
  onSaved?: () => void;
  /** Shown in the status line when the dialog opens. */
  hint?: string;
}

/** Open the settings dialog (single instance). */
export function openSettings(opts: SettingsOptions = {}): void {
  if (modalOpen) return;
  modalOpen = true;

  const backdrop = document.createElement("div");
  backdrop.className = "ai-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "ai-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "AI settings");

  modal.appendChild(h2El("AI 设置 / AI Settings"));

  const intro = pEl(
    "ai-privacy",
    "Bring your own OpenAI-compatible / Anthropic-compatible API key. The " +
    "key never leaves your browser except to the endpoint you specify " +
    "(relayed via our /api/llm passthrough).",
  );
  modal.appendChild(intro);

  /* ---- profile picker row ---- */
  const store = loadProfiles();
  let editingId =
    store.profiles.find((p) => p.id === store.defaultId)?.id ??
    store.profiles[0]?.id;

  const pickerRow = document.createElement("div");
  pickerRow.className = "ai-field ai-profile-row";

  const profileSel = document.createElement("select");
  profileSel.className = "ai-select";
  profileSel.setAttribute("aria-label", "Profile being edited");

  const newBtn = btnEl("ai-secondary", "New");
  const delBtn = btnEl("ai-secondary", "Delete");
  const defBtn = btnEl("ai-secondary", "Set default");
  pickerRow.append(profileSel, newBtn, delBtn, defBtn);
  modal.appendChild(pickerRow);

  /* ---- editable fields for the selected profile ---- */
  const nameInp = inputField("Profile name");
  const protoSel = selectField("Protocol", [
    { v: "openai", label: "openai — chat/completions (OpenAI & compatible)" },
    { v: "anthropic", label: "anthropic — /v1/messages" },
    { v: "responses", label: "responses — OpenAI /v1/responses" },
  ]) as HTMLSelectElement;
  const baseUrlInp = inputField(
    "Provider Base URL", DEFAULT_BASE_URL.openai);
  const keyInp = inputField("API Key");
  keyInp.type = "password";
  keyInp.autocomplete = "off";
  const modelInp = inputField("Model");
  const effSel = selectField("Thinking effort", EFFORTS.map((e) => ({
    v: e.v as string, label: e.label,
  }))) as HTMLSelectElement;

  const fieldsWrap = document.createElement("div");
  fieldsWrap.append(
    nameInp.closest(".ai-field") as HTMLElement,
    protoSel.closest(".ai-field") as HTMLElement,
    baseUrlInp.closest(".ai-field") as HTMLElement,
    keyInp.closest(".ai-field") as HTMLElement,
    modelInp.closest(".ai-field") as HTMLElement,
    effSel.closest(".ai-field") as HTMLElement,
  );
  modal.appendChild(fieldsWrap);

  const baseUrlHint = pEl(
    "ai-hint",
    "Examples: https://api.openai.com/v1 · https://openrouter.ai/api/v1 · " +
    "https://api.anthropic.com · DeepSeek or a local LM Studio/Ollama URL.",
  );
  fieldsWrap.insertBefore(
    baseUrlHint, baseUrlInp.closest(".ai-field")!.nextSibling);

  const keyHint = pEl(
    "ai-hint",
    "anthropic protocol sends the credential as the x-api-key header.",
  );
  keyHint.hidden = true;
  fieldsWrap.insertBefore(keyHint, modelInp.closest(".ai-field")!.nextSibling);

  const effHint = pEl(
    "ai-hint",
    "Optional reasoning effort: openai → reasoning_effort, anthropic → " +
    "thinking budget (2048/8192/16384 tokens), responses → reasoning.effort.",
  );
  fieldsWrap.insertBefore(effHint, effSel.closest(".ai-field")!.nextSibling);

  /* ---- cost guards ---- */
  modal.appendChild(h3El("Cost guards"));
  const caps = loadCaps();
  const callsInp = numberInput(
    `Max calls per hour (${CAP_LIMITS.minCalls}–${CAP_LIMITS.maxCalls})`,
    String(caps.maxCallsPerHour),
  );
  const charsInp = numberInput(
    `Max prompt characters (${CAP_LIMITS.defaultChars.toLocaleString()} default)`,
    String(caps.maxInputChars),
  );
  modal.append(callsInp.closest(".ai-field") as HTMLElement);
  modal.appendChild(charsInp.closest(".ai-field") as HTMLElement);
  modal.appendChild(pEl(
    "ai-hint",
    "Hard caps with a sliding one-hour window: when reached, every further " +
    "call needs an explicit confirmation showing usage + reset time. Input " +
    "over the character cap is refused outright. Anti-runaway design: each " +
    "AI request fires only from its own button click — asking about many " +
    "words means clicking per word; there is no bulk-translate loop.",
  ));

  /* ---- prompt template ---- */
  modal.appendChild(h3El("Prompt template"));
  const tplTa = document.createElement("textarea");
  tplTa.className = "ai-template";
  tplTa.rows = 8;
  tplTa.spellcheck = false;
  tplTa.value = loadTemplate();
  const tplField = document.createElement("div");
  tplField.className = "ai-field ai-field-template";
  tplField.appendChild(labelFor("Template (editable)", tplTa));
  modal.appendChild(tplField);
  modal.appendChild(pEl(
    "ai-hint",
    `Placeholders: ${TEMPLATE_PLACEHOLDERS.join(", ")}. Every request ` +
    `appends: "${DATA_NOTE}"`,
  ));

  /* ---- status + buttons ---- */
  const status = pEl("ai-status", "");
  status.setAttribute("aria-live", "polite");

  const testBtn = btnEl("ai-secondary", "Test Connection");
  const saveBtn = btnEl("ai-primary", "Save");
  const closeBtn = btnEl("ai-secondary", "Close");
  const btnRow = document.createElement("div");
  btnRow.className = "ai-btn-row";
  btnRow.append(testBtn, saveBtn, closeBtn);
  modal.append(status, btnRow);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  if (opts.hint) {
    status.textContent = opts.hint;
    status.classList.add("ai-ok");
  }

  /* ---- profile switching / CRUD ---- */
  const refreshPicker = (): void => {
    const st = loadProfiles();
    profileSel.replaceChildren();
    for (const p of st.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      const mark = p.id === st.defaultId ? " ★" : "";
      o.textContent = `${p.name}${mark}`;
      profileSel.appendChild(o);
    }
    if (!st.profiles.find((p) => p.id === editingId)) {
      editingId = st.profiles[0]?.id;
    }
    if (editingId) profileSel.value = editingId;
    loadIntoForm();
  };

  const currentProfile = (): Profile =>
    loadProfiles().profiles.find((p) => p.id === editingId) ??
    loadProfiles().profiles[0];

  function loadIntoForm(): void {
    const p = currentProfile();
    if (!p) return;
    nameInp.value = p.name;
    protoSel.value = p.protocol;
    baseUrlInp.value = p.baseUrl;
    keyInp.value = p.apiKey;
    modelInp.value = p.model;
    effSel.value = p.effort ?? "";
    applyProtoVisibility();
  }

  function formToProfile(): Profile {
    const prev = currentProfile();
    const protocol = (PROTOCOLS.includes(protoSel.value as Protocol)
      ? protoSel.value : "openai") as Protocol;
    return {
      id: prev?.id ?? newId(),
      name: nameInp.value.trim() || protocol,
      protocol,
      baseUrl: baseUrlInp.value.trim(),
      apiKey: keyInp.value,
      model: modelInp.value.trim(),
      effort: effSel.value as Effort,
    };
  }

  const BUDGETS = ["2048", "8192", "16384"];
  function applyProtoVisibility(): void {
    const proto = PROTOCOLS.includes(protoSel.value as Protocol)
      ? (protoSel.value as Protocol) : "openai";
    const effField = effSel.closest(".ai-field") as HTMLElement;
    const effLabel = effField.querySelector("label") as
      HTMLLabelElement | null;
    if (proto === "anthropic") {
      if (effLabel) effLabel.textContent = "Thinking budget";
      effSel.replaceChildren(...BUDGETS.map((b) => {
        const o = document.createElement("option");
        o.value = b; o.textContent = `${b} tokens`;
        return o;
      }));
      keyHint.hidden = false;
    } else {
      if (effLabel) {
        effLabel.textContent = proto === "responses"
          ? "Reasoning effort (reasoning.effort)"
          : "Reasoning effort (reasoning_effort)";
      }
      const hasEfforts = [...effSel.options].some((o) =>
        EFFORTS.some((e) => e.v === o.value));
      if (!hasEfforts) {
        effSel.replaceChildren(...EFFORTS.map((e) => {
          const o = document.createElement("option");
          o.value = e.v as string; o.textContent = e.label;
          return o;
        }));
        effSel.value = currentProfile()?.effort ?? "";
      }
      keyHint.hidden = true;
    }
  }
  protoSel.addEventListener("change", () => {
    // persist edits of the previous profile before switching
    commitEdits(false);
    editingId = profileSel.value;
    loadIntoForm();
    applyProtoVisibility();
  });

  function commitEdits(switchAfter: boolean): void {
    const st = loadProfiles();
    const edited = formToProfile();
    const idx = st.profiles.findIndex((p) => p.id === edited.id);
    if (idx >= 0) st.profiles[idx] = edited;
    else st.profiles.push(edited);
    saveProfiles(st.profiles, st.defaultId);
    if (switchAfter && edited.id === readActiveId()) setActiveProfile(edited.id);
  }

  const readActiveId = (): string | undefined => {
    try {
      return JSON.parse(localStorage.getItem("greek-reader.llm") ?? "{}")
        .activeProfileId as string | undefined;
    } catch {
      return undefined;
    }
  };

  newBtn.addEventListener("click", () => {
    commitEdits(false);
    const st = loadProfiles();
    const p = newDefaultProfile("openai");
    p.name = `Profile ${st.profiles.length + 1}`;
    st.profiles.push(p);
    saveProfiles(st.profiles, st.defaultId);
    editingId = p.id;
    refreshPicker();
    status.textContent = "Profile created.";
    status.classList.remove("ai-error");
  });

  delBtn.addEventListener("click", () => {
    const st = loadProfiles();
    if (st.profiles.length <= 1) {
      status.textContent = "Cannot delete the last profile.";
      status.classList.add("ai-error");
      return;
    }
    const rest = st.profiles.filter((p) => p.id !== editingId);
    const defaultId =
      st.defaultId === editingId ? rest[0].id : st.defaultId;
    saveProfiles(rest, defaultId);
    if (readActiveId() === editingId) setActiveProfile(rest[0].id);
    editingId = rest[0].id;
    refreshPicker();
    status.textContent = "Profile deleted.";
    status.classList.remove("ai-error");
  });

  defBtn.addEventListener("click", () => {
    const st = loadProfiles();
    if (!st.profiles.find((p) => p.id === editingId)) return;
    saveProfiles(st.profiles, editingId);
    refreshPicker();
    status.textContent = "Default profile updated.";
    status.classList.remove("ai-error");
  });

  /* ---- close/save/test ---- */
  const close = (): void => {
    backdrop.remove();
    modalOpen = false;
    document.removeEventListener("keydown", onKey);
    opts.onSaved?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener("click", close);

  const validate = (): string | null => {
    if (!formToProfile().model) return "Model name is required.";
    if (!baseUrlInp.value.trim().startsWith("https://")) {
      return "Base URL must start with https:// (the relay rejects other schemes).";
    }
    return null;
  };

  saveBtn.addEventListener("click", () => {
    const err = validate();
    if (err) {
      status.textContent = err;
      status.className = "ai-status ai-error";
      return;
    }
    try {
      commitEdits(true);
      saveCaps({
        maxCallsPerHour: Number(callsInp.value) || CAP_LIMITS.defaultCalls,
        maxInputChars: Number(charsInp.value) || CAP_LIMITS.defaultChars,
      });
      saveTemplate(tplTa.value);
      status.textContent = "Saved to this browser (localStorage).";
      status.className = "ai-status ai-ok";
    } catch (e) {
      status.textContent = `Could not save: ${(e as Error).message}`;
      status.className = "ai-status ai-error";
    }
  });

  testBtn.addEventListener("click", () => {
    const err = validate();
    if (err) {
      status.textContent = err;
      status.className = "ai-status ai-error";
      return;
    }
    testBtn.disabled = true;
    status.textContent = "Testing…";
    status.className = "ai-status";
    const started = Date.now();
    callLLM(
      { system: "Reply with the single word: OK", user: "ping" },
      { profileOverride: { ...formToProfile(), effort: "" } },
    )
      .then((text) => {
        const ms = ((Date.now() - started) / 1000).toFixed(1);
        status.textContent =
          `OK (${ms}s) — replied: ${text.trim().slice(0, 80) || "(empty)"}`;
        status.className = "ai-status ai-ok";
      })
      .catch((e: Error) => {
        status.textContent = `Failed: ${e.message}`;
        status.className = "ai-status ai-error";
      })
      .finally(() => {
        testBtn.disabled = false;
      });
  });

  refreshPicker();
  keyInp.focus();
}

/* ---------------- small builders ---------------- */

function h2El(text: string): HTMLHeadingElement {
  const el = document.createElement("h2");
  el.textContent = text;
  return el;
}
function h3El(text: string): HTMLHeadingElement {
  const el = document.createElement("h3");
  el.textContent = text;
  return el;
}
function pEl(cls: string, text: string): HTMLParagraphElement {
  const el = document.createElement("p");
  el.className = cls;
  el.textContent = text;
  return el;
}
function btnEl(cls: string, text: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = cls;
  el.type = "button";
  el.textContent = text;
  return el;
}

function labelFor(text: string, control: HTMLElement): HTMLLabelElement {
  const lab = document.createElement("label");
  lab.className = "ai-label";
  const span = document.createElement("span");
  span.textContent = text;
  lab.append(span, control);
  return lab;
}

function wrapField(control: HTMLElement, labelText: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ai-field";
  wrap.appendChild(labelFor(labelText, control));
  return wrap;
}

function inputField(labelText: string, placeholder = ""): HTMLInputElement {
  const inp = document.createElement("input");
  inp.spellcheck = false;
  if (placeholder) inp.placeholder = placeholder;
  wrapField(inp, labelText);
  return inp;
}

function numberInput(labelText: string, value: string): HTMLInputElement {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.value = value;
  wrapField(inp, labelText);
  return inp;
}

function selectField(
  labelText: string,
  options: Array<{ v: string; label: string }>,
): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "ai-select";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  wrapField(sel, labelText);
  return sel;
}
