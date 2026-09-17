"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const fmt = (v, p = 3) => (v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(p));
const pct = (v) => (v === null || v === undefined || Number.isNaN(v) ? "—" : (v * 100).toFixed(1) + "%");
const signed = (v, p = 3) => (v === null || v === undefined || Number.isNaN(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(p));

/* In static mode the page is a published snapshot: it reads a baked JSON file and the
   Run/Jobs tabs do not exist, because no runner is reachable from a static host. */
const STATIC = Boolean(window.SRB_STATIC);

async function api(path, options) {
  if (STATIC) {
    if (path === "/api/leaderboard") {
      const res = await fetch("leaderboard.json");
      if (!res.ok) throw new Error("could not load leaderboard.json");
      return res.json();
    }
    throw new Error("this is a read-only published snapshot");
  }
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  return res.json();
}

/* ------------------------------------------------------------------ tabs */
let activeTab = "leaderboard";
document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll("nav button").forEach((b) =>
      b.setAttribute("aria-current", b === btn ? "page" : "false"));
    document.querySelectorAll(".panel").forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${activeTab}`));
    if (activeTab === "leaderboard") loadLeaderboard();
    if (activeTab === "jobs") loadJobs();
  });
});

/* ----------------------------------------------------------- leaderboard */
let selectedModel = null;

async function loadLeaderboard() {
  const body = $("#leaderboard-body");
  let data;
  try {
    data = await api("/api/leaderboard");
  } catch (err) {
    body.replaceChildren(el("div", { class: "err" }, `Could not load results: ${err.message}`));
    return;
  }
  if (!data.rows.length) {
    body.replaceChildren(el("div", { class: "empty" },
      "No runs yet. Open the Run tab — mock:v1 needs no API key and finishes in seconds."));
    $("#detail").replaceChildren();
    return;
  }

  const head = el("tr", {},
    el("th", {}, "#"), el("th", {}, "Model"), el("th", {}, "TVD"),
    el("th", { title: "TVD minus the sampling floor: the part not explained by sampling noise" }, "Excess"),
    el("th", { title: "Irreducible TVD from drawing only k samples. No simulator beats this." }, "Floor"),
    el("th", { title: "Worst minus best prompt variant. Large spread = you are measuring a prompt." }, "Spread"),
    el("th", { title: "Mean absolute error across the 7 constraint types" }, "Facet MAE"),
    el("th", { title: "Model minus human share of tokens absent from the result page" }, "Novelty"),
    el("th", {}, "Items"), el("th", {}, "k"), el("th", {}, "Beats marginal"));

  const rows = data.rows.map((row, i) => {
    const tr = el("tr", {
      class: "clickable" + (row.model === selectedModel ? " selected" : ""),
      onclick: () => { selectedModel = row.model; loadLeaderboard(); },
    },
      el("td", { class: "rank" }, i + 1),
      el("td", { class: "model-name" }, row.model),
      el("td", {}, fmt(row.tvd)),
      el("td", {}, fmt(row.excess)),
      el("td", {}, fmt(row.sampling_floor)),
      el("td", { title: `best ${fmt(row.tvd_best)} (${row.best_prompt}) / worst ${fmt(row.tvd_worst)}` },
        fmt(row.prompt_spread)),
      el("td", {}, fmt(row.facet_mae)),
      el("td", {}, signed(row.novelty_gap)),
      el("td", {}, row.n_items),
      el("td", {}, row.k),
      el("td", {}, el("span", { class: "pill " + (row.beats_marginal ? "good" : "bad") },
        row.beats_marginal ? "yes" : "no")));
    return tr;
  });

  const provenance = STATIC
    ? el("p", { class: "note", style: "margin:12px 0 0" },
        `Read-only snapshot of ${data.n_runs} runs, generated ${
          data.generated ? new Date(data.generated).toUTCString() : "unknown"
        }. ` + (data.note ? data.note + " " : "") +
        "Evaluations run locally; this page is published from their results.")
    : null;
  body.replaceChildren(
    el("table", {}, el("thead", {}, head), el("tbody", {}, rows)),
    provenance || el("span", {}));
  if (!selectedModel || !data.rows.some((r) => r.model === selectedModel)) {
    selectedModel = data.rows[0].model;
    body.querySelector("tbody tr").classList.add("selected");
  }
  renderDetail(data.rows.find((r) => r.model === selectedModel));
}

/* Position-on-scale meter. One value in context: the model is the accent, the
   reference points are recessive ink. Labels stagger onto a second row when two
   references fall too close to sit side by side. */
function meter(row) {
  const W = 680, H = 96, PAD = 16, y = 38;
  const x = (v) => PAD + Math.max(0, Math.min(1, v)) * (W - 2 * PAD);
  const refs = [
    ["floor", row.sampling_floor],
    ["human split", row.human_holdout],
    ["marginal", row.marginal],
    ["uniform", row.uniform],
  ]
    .filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v))
    .sort((a, b) => a[1] - b[1]);

  // Place each label on row 0 unless it would overlap the last label on that row.
  const MIN_GAP = 74;
  const lastX = [-Infinity, -Infinity];
  const placed = refs.map(([label, v]) => {
    const px = x(v);
    const lane = px - lastX[0] >= MIN_GAP ? 0 : 1;
    lastX[lane] = px;
    return { label, v, px, lane };
  });

  const marks = placed.map(({ label, v, px, lane }) => {
    const tickBottom = lane === 0 ? y + 9 : y + 26;
    const textY = lane === 0 ? y + 23 : y + 40;
    return `
    <line x1="${px}" y1="${y - 9}" x2="${px}" y2="${tickBottom}"
          stroke="var(--border-strong)" stroke-width="1"/>
    <text x="${px}" y="${textY}" text-anchor="middle" font-size="10"
          fill="var(--text-muted)">${label}</text>
    <text x="${px}" y="${y - 14}" text-anchor="middle" font-size="9.5"
          fill="var(--text-muted)" font-variant-numeric="tabular-nums">${fmt(v, 2)}</text>`;
  }).join("");

  const modelX = x(row.tvd);
  const wrap = el("div");
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
         aria-label="Model TVD ${fmt(row.tvd)} against a floor of ${fmt(row.sampling_floor)} and a marginal of ${fmt(row.marginal)}">
      <line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}"
            stroke="var(--border)" stroke-width="2"/>
      ${marks}
      <circle cx="${modelX}" cy="${y}" r="6" fill="var(--series-model)"
              stroke="var(--surface-1)" stroke-width="2"/>
      <text x="${modelX}" y="${y - 14}" text-anchor="middle" font-size="10.5"
            font-weight="600" fill="var(--series-model)"
            font-variant-numeric="tabular-nums">${fmt(row.tvd)}</text>
      <text x="${modelX}" y="${y + 23}" text-anchor="middle" font-size="10"
            font-weight="600" fill="var(--series-model)">this model</text>
    </svg>`;
  return wrap.firstElementChild;
}

/* Bar-in-table. Values live in table columns, so nothing floats on a mark and
   the table view and the chart are the same object. */
function barTable(categories, humanValues, modelValues) {
  const max = Math.max(0.0001, ...humanValues, ...modelValues);
  const rows = categories.map((cat, i) => {
    const h = humanValues[i], m = modelValues[i];
    const delta = m - h;
    return el("tr", {},
      el("td", { class: "cat" }, cat),
      el("td", { class: "barcell" },
        el("div", { class: "bar-pair", title: `${cat}\nhumans ${pct(h)}\nmodel ${pct(m)}` },
          el("div", { class: "bar-track" },
            el("div", { class: "bar-fill human", style: `width:${(h / max) * 100}%` })),
          el("div", { class: "bar-track" },
            el("div", { class: "bar-fill model", style: `width:${(m / max) * 100}%` })))),
      el("td", {}, pct(h)),
      el("td", {}, pct(m)),
      el("td", { class: "delta " + (delta >= 0 ? "over" : "under") }, signed(delta * 100, 1)));
  });
  return el("table", { class: "bartable" },
    el("thead", {}, el("tr", {},
      el("th", {}, ""), el("th", {}, ""), el("th", {}, "Humans"),
      el("th", {}, "Model"), el("th", {}, "Δ pp"))),
    el("tbody", {}, rows));
}

const legend = () => el("div", { class: "legend" },
  el("span", {}, el("i", { class: "swatch human" }), "Real shoppers"),
  el("span", {}, el("i", { class: "swatch model" }), "Model"));

function renderDetail(row) {
  if (!row) { $("#detail").replaceChildren(); return; }

  const promptRows = row.per_prompt.map((p) => el("tr", {},
    el("td", { class: "cat" }, p.prompt),
    el("td", {}, fmt(p.tvd)),
    el("td", {}, `[${fmt(p.ci[0])}, ${fmt(p.ci[1])}]`),
    el("td", {}, fmt(p.excess)),
    el("td", {}, fmt(p.facet_mae)),
    el("td", {}, signed(p.novelty_gap)),
    el("td", {}, el("span", { class: "pill " + (p.beats_marginal ? "good" : "bad") },
      p.beats_marginal ? "yes" : "no"))));

  $("#detail").replaceChildren(
    el("div", { class: "card" },
      el("h2", {}, `${row.model} — where it sits`),
      el("p", { class: "note" },
        `Run ${row.run_id} · ${row.n_items} items · k=${row.k} · ${row.elicit} elicitation` +
        (row.actual_usd !== null && row.actual_usd !== undefined
          ? ` · ${(row.input_tokens + row.output_tokens).toLocaleString()} tokens, $${row.actual_usd.toFixed(2)} actual`
          : "") +
        (row.refusals || row.errors ? ` · ${row.refusals} refusals, ${row.errors} errors` : "")),
      meter(row),
      el("p", { class: "meter-caption" },
        "Scale is TVD from 0 (identical to human) to 1. Only the distance past the floor is signal.")),

    el("div", { class: "grid2" },
      el("div", { class: "card" },
        el("h2", {}, "Refinement types"),
        el("p", { class: "note" }, "How the query changed, as a share of all refinements."),
        legend(), barTable(row.classes, row.human_dist, row.model_dist)),
      el("div", { class: "card" },
        el("h2", {}, "Constraints added"),
        el("p", { class: "note" }, "Share of refinements introducing each constraint type. Multi-label."),
        legend(), barTable(row.facet_classes, row.human_facets, row.model_facets))),

    el("div", { class: "card" },
      el("h2", {}, "By prompt variant"),
      el("p", { class: "note" },
        "Spread across framings is part of the measurement, not noise to average away."),
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", {}, "Prompt"), el("th", {}, "TVD"), el("th", {}, "95% CI"),
          el("th", {}, "Excess"), el("th", {}, "Facet MAE"), el("th", {}, "Novelty"),
          el("th", {}, "Beats marginal"))),
        el("tbody", {}, promptRows))));
}

/* ------------------------------------------------------------------- run */
let config = null;

async function loadConfig() {
  config = await api("/api/config");

  $("#presets").replaceChildren(...config.model_presets.map((spec) =>
    el("button", {
      type: "button", class: "ghost",
      onclick: () => {
        const box = $("#models");
        const lines = box.value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!lines.includes(spec)) lines.push(spec);
        box.value = lines.join("\n");
        refreshEstimate();
      },
    }, "+ " + spec)));

  $("#prompts").replaceChildren(...config.prompts.map((name) =>
    el("label", {}, el("input", { type: "checkbox", value: name, checked: true,
      onchange: refreshEstimate }), name)));

  $("#corpus").replaceChildren(...config.corpora.map((name) =>
    el("option", { value: name, selected: name === "corpus_full.jsonl" }, name)));

  const keys = [];
  if (!config.keys.anthropic) keys.push("ANTHROPIC_API_KEY is not set");
  if (!config.keys.openai) keys.push("OPENAI_API_KEY is not set");
  $("#key-status").replaceChildren(keys.length
    ? el("div", { class: "estimate" },
        keys.join(" · ") + ". Those providers will be rejected; mock:v1 always works.")
    : el("span", {}));

  if (!$("#models").value.trim()) {
    $("#models").value = config.keys.anthropic ? "anthropic:claude-opus-5" : "mock:v1";
  }
  refreshEstimate();
}

function formSpec() {
  return {
    models: $("#models").value.split("\n").map((s) => s.trim()).filter(Boolean),
    prompts: [...document.querySelectorAll("#prompts input:checked")].map((i) => i.value),
    corpus: $("#corpus").value,
    n_items: Number($("#n_items").value),
    k: Number($("#k").value),
    elicit: $("#elicit").value,
    effort: $("#effort").value || null,
  };
}

let estimateTimer = null;
function refreshEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(async () => {
    try {
      const est = await api("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formSpec()),
      });
      const unpriced = est.unpriced.length
        ? ` (no price on file for ${est.unpriced.join(", ")} — cost excludes them)` : "";
      $("#estimate").innerHTML =
        `<strong>${est.calls.toLocaleString()}</strong> API calls · estimated ` +
        `<strong>$${est.usd.toFixed(2)}</strong>${unpriced}. Cached responses are free on rerun.`;
      $("#run-error").hidden = true;
      $("#start-btn").disabled = false;
    } catch (err) {
      $("#estimate").textContent = "—";
      $("#run-error").textContent = err.message;
      $("#run-error").hidden = false;
      $("#start-btn").disabled = true;
    }
  }, 220);
}

["#models", "#n_items", "#k", "#elicit", "#corpus", "#effort"].forEach((sel) =>
  $(sel).addEventListener("input", refreshEstimate));

$("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#start-btn").disabled = true;
  try {
    const job = await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formSpec()),
    });
    openJobs(job.id);
  } catch (err) {
    $("#run-error").textContent = err.message;
    $("#run-error").hidden = false;
  } finally {
    $("#start-btn").disabled = false;
  }
});

/* ------------------------------------------------------------------ jobs */
let openJobId = null;
let pollTimer = null;

function openJobs(jobId) {
  openJobId = jobId || openJobId;
  document.querySelector('nav button[data-tab="jobs"]').click();
}

const STATUS_CLASS = { running: "warn", done: "good", failed: "bad",
                       cancelled: "", orphaned: "bad" };

async function loadJobs() {
  let data;
  try {
    data = await api("/api/jobs");
  } catch (err) {
    $("#jobs-body").replaceChildren(el("div", { class: "err" }, err.message));
    return;
  }
  if (!data.jobs.length) {
    $("#jobs-body").replaceChildren(el("div", { class: "empty" }, "No jobs yet."));
    $("#job-log-card").hidden = true;
    return;
  }

  const rows = data.jobs.map((job) => el("tr", {
    class: "clickable" + (job.id === openJobId ? " selected" : ""),
    onclick: () => { openJobId = job.id; loadJobs(); },
  },
    el("td", { class: "model-name" }, job.id),
    el("td", { class: "cat", style: "text-align:left" }, job.config.models.join(", ")),
    el("td", {}, job.config.prompts.length),
    el("td", {}, job.config.n_items),
    el("td", {}, job.config.k),
    el("td", {}, job.estimate ? "$" + job.estimate.usd.toFixed(2) : "—"),
    el("td", {}, new Date(job.created).toLocaleString()),
    el("td", {}, el("span", { class: "pill " + (STATUS_CLASS[job.status] || "") }, job.status)),
    el("td", {}, job.status === "running"
      ? el("button", {
          class: "ghost",
          onclick: async (ev) => {
            ev.stopPropagation();
            await api(`/api/jobs/${job.id}/cancel`, { method: "POST" }).catch(() => {});
            loadJobs();
          },
        }, "Cancel")
      : "")));

  $("#jobs-body").replaceChildren(el("table", {},
    el("thead", {}, el("tr", {},
      el("th", {}, "Job"), el("th", {}, "Models"), el("th", {}, "Prompts"),
      el("th", {}, "Items"), el("th", {}, "k"), el("th", {}, "Est."),
      el("th", {}, "Started"), el("th", {}, "Status"), el("th", {}, ""))),
    el("tbody", {}, rows)));

  if (!openJobId) openJobId = data.jobs[0].id;
  const job = await api(`/api/jobs/${openJobId}`).catch(() => null);
  if (job) {
    $("#job-log-card").hidden = false;
    $("#job-log-id").textContent = job.id;
    $("#job-log-cmd").textContent = job.command;
    const pre = $("#job-log");
    const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = job.log || "(waiting for output)";
    if (pinned) pre.scrollTop = pre.scrollHeight;
  }

  clearTimeout(pollTimer);
  if (data.jobs.some((j) => j.status === "running")) {
    pollTimer = setTimeout(() => { if (activeTab === "jobs") loadJobs(); }, 2000);
  } else if (job && job.status === "done") {
    loadLeaderboard();
  }
}

/* ------------------------------------------------------------------ boot */
if (STATIC) {
  document.querySelectorAll('nav button[data-tab="run"], nav button[data-tab="jobs"]')
    .forEach((b) => b.remove());
  document.querySelectorAll("#tab-run, #tab-jobs").forEach((p) => p.remove());
  loadLeaderboard();
} else {
  loadConfig().catch((err) => {
    $("#key-status").replaceChildren(el("div", { class: "err" }, err.message));
  });
  loadLeaderboard();
}
