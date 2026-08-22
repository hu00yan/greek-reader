// Settings modal: bring-your-own-key provider configuration.
// Persisted ONLY to localStorage key "greek-reader.llm" (see src/llm.ts).
// All DOM built with createElement/textContent — no innerHTML anywhere.

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TEMPLATE,
  TEMPLATE_PLACEHOLDERS,
  callLLM,
  loadConfig,
  saveConfig,
  type LlmConfig,
} from "./llm";

interface FieldRefs {
  baseUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  model: HTMLInputElement;
  temperature: HTMLInputElement;
  template: HTMLTextAreaElement;
}

let modalOpen = false;

interface SettingsOptions {
  onSaved?: () => void;
  /** Shown in the status line when the dialog opens (e.g. "no key yet"). */
  hint?: string;
}

/** Open (or focus) the settings dialog; resolves when it is closed. */
export function openSettings(opts: SettingsOptions = {}): void {
  if (modalOpen) return;
  const cfg = loadConfig();
  modalOpen = true;

  const backdrop = document.createElement("div");
  backdrop.className = "ai-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "ai-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "AI settings");

  const h2 = document.createElement("h2");
  h2.textContent = "AI 设置 / AI Settings";
  modal.appendChild(h2);

  const intro = document.createElement("p");
  intro.className = "ai-privacy";
  intro.textContent =
    "Bring your own OpenAI-compatible API key. The key never leaves your " +
    "browser except to the endpoint you specify (relayed via our /api/llm " +
    "passthrough).";
  modal.appendChild(intro);

  const fields: FieldRefs = {
    baseUrl: inputField("Provider Base URL", cfg.baseUrl || DEFAULT_BASE_URL),
    apiKey: inputField("API Key", cfg.apiKey ?? ""),
    model: inputField("Model", cfg.model || DEFAULT_MODEL),
    temperature: inputField(
      "Temperature (optional, e.g. 0.2)",
      cfg.temperature !== undefined ? String(cfg.temperature) : "",
    ),
    template: promptField(cfg.template ?? DEFAULT_TEMPLATE),
  };

  fields.baseUrl.setAttribute("placeholder", DEFAULT_BASE_URL);
  fields.baseUrl.name = "baseUrl";
  fields.apiKey.type = "password";
  fields.apiKey.autocomplete = "off";
  fields.model.placeholder = DEFAULT_MODEL;
  fields.temperature.type = "number";
  fields.temperature.step = "0.1";
  fields.temperature.min = "0";
  fields.temperature.max = "2";

  for (const f of [fields.baseUrl, fields.apiKey, fields.model, fields.temperature]) {
    modal.appendChild(f.closest(".ai-field") as HTMLElement);
  }

  // base-url hint
  const hint = document.createElement("p");
  hint.className = "ai-hint";
  hint.textContent =
    "Any OpenAI-compatible endpoint works — OpenRouter " +
    "(https://openrouter.ai/api/v1), DeepSeek (https://api.deepseek.com/v1), " +
    "a local LM Studio or Ollama URL, …";
  (fields.baseUrl.closest(".ai-field") as HTMLElement).after(hint);

  // prompt template
  modal.appendChild(fields.template.closest(".ai-field") as HTMLElement);
  const tHint = document.createElement("p");
  tHint.className = "ai-hint";
  tHint.textContent =
    `Prompt template sent to the model. Placeholders: ` +
    `${TEMPLATE_PLACEHOLDERS.join(", ")}.`;
  (fields.template.closest(".ai-field") as HTMLElement).after(tHint);

  // status line + buttons
  const status = document.createElement("p");
  status.className = "ai-status";
  status.setAttribute("aria-live", "polite");

  const btnRow = document.createElement("div");
  btnRow.className = "ai-btn-row";

  const testBtn = document.createElement("button");
  testBtn.className = "ai-secondary";
  testBtn.textContent = "Test Connection";

  const saveBtn = document.createElement("button");
  saveBtn.className = "ai-primary";
  saveBtn.textContent = "Save";

  const closeBtn = document.createElement("button");
  closeBtn.className = "ai-secondary";
  closeBtn.textContent = "Close";

  btnRow.append(testBtn, saveBtn, closeBtn);
  modal.append(status, btnRow);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  if (opts.hint) {
    status.className = "ai-status";
    status.textContent = opts.hint;
  }

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

  const readForm = (): LlmConfig => {
    const tRaw = fields.temperature.value.trim();
    const temp = tRaw === "" ? undefined : Number(tRaw);
    return {
      baseUrl: fields.baseUrl.value.trim() || DEFAULT_BASE_URL,
      apiKey: fields.apiKey.value,
      model: fields.model.value.trim(),
      temperature: temp !== undefined && Number.isFinite(temp) ? temp : undefined,
      template: fields.template.value,
    };
  };

  saveBtn.addEventListener("click", () => {
    const form = readForm();
    if (!form.model) {
      status.className = "ai-status ai-error";
      status.textContent = "Model name is required.";
      return;
    }
    try {
      saveConfig(form); // localStorage only
    } catch (e) {
      status.className = "ai-status ai-error";
      status.textContent = `Could not save: ${(e as Error).message}`;
      return;
    }
    status.className = "ai-status ai-ok";
    status.textContent = "Saved to this browser (localStorage).";
  });

  testBtn.addEventListener("click", () => {
    const form = readForm();
    if (!form.model) {
      status.className = "ai-status ai-error";
      status.textContent = "Model name is required.";
      return;
    }
    // Test against the FORM values so unsaved edits can be verified first.
    testBtn.disabled = true;
    status.className = "ai-status";
    status.textContent = "Testing…";
    const started = Date.now();
    callLLM([{ role: "user", content: "Reply with the single word: OK" }], {
      configOverride: form,
    })
      .then((text) => {
        const ms = ((Date.now() - started) / 1000).toFixed(1);
        status.className = "ai-status ai-ok";
        status.textContent =
          `OK (${ms}s) — model replied: ${text.trim().slice(0, 80) || "(empty)"}`;
      })
      .catch((err: Error) => {
        status.className = "ai-status ai-error";
        status.textContent = `Failed: ${err.message}`;
      })
      .finally(() => {
        testBtn.disabled = false;
      });
  });

  fields.apiKey.focus();
}

/* ---------------- field builders ---------------- */

function labelFor(text: string, control: HTMLElement): HTMLLabelElement {
  const lab = document.createElement("label");
  lab.className = "ai-label";
  const span = document.createElement("span");
  span.textContent = text;
  lab.appendChild(span);
  lab.appendChild(control);
  return lab;
}

function inputField(labelText: string, value: string): HTMLInputElement {
  const wrap = document.createElement("div");
  wrap.className = "ai-field";
  const inp = document.createElement("input");
  inp.value = value;
  inp.spellcheck = false;
  wrap.appendChild(labelFor(labelText, inp));
  return inp;
}

function promptField(value: string): HTMLTextAreaElement {
  const wrap = document.createElement("div");
  wrap.className = "ai-field ai-field-template";
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.rows = 8;
  ta.spellcheck = false;
  ta.className = "ai-template";
  wrap.appendChild(labelFor("Prompt template", ta));
  return ta;
}
