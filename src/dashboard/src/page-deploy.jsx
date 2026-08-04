/* global React, Icons, Pill, Api, useApp */
const { useState: useState5, useEffect: useEffect5 } = React;

function PageDeploy() {
  const { pushToast } = useApp();

  // form fields
  const [definitionId, setDefinitionId]   = useState5("my-machine-v2");
  const [parent, setParent]               = useState5("");
  const [code, setCode]                   = useState5(JSON.stringify({
    initial: "idle",
    states: {
      idle:   { on: { START: "active" } },
      active: { on: { FINISH: "done" } },
      done:   { type: "final" }
    }
  }, null, 2));
  const [historyPath, setHistoryPath]     = useState5([]);
  const [newEvent, setNewEvent]           = useState5("");
  const [showMapping, setShowMapping]     = useState5(false);
  const [mappings, setMappings]           = useState5([{ old: "", new: "" }]);

  // parent defs loader
  const [definitions, setDefinitions]     = useState5([]);
  const [defsLoading, setDefsLoading]     = useState5(true);

  // deploy flow state
  const [step, setStep]                   = useState5(1);
  const [deploying, setDeploying]         = useState5(false);
  const [deployError, setDeployError]     = useState5(null);
  const [deployResult, setDeployResult]   = useState5(null);
  const [dryRunResult, setDryRunResult]   = useState5(null);
  const [strandedActors, setStrandedActors] = useState5([]);
  const [realConfirmToken, setRealConfirmToken] = useState5(null);
  const [realExpiresIn, setRealExpiresIn] = useState5(300);
  const [confirmed, setConfirmed]         = useState5(false);
  const [jsonError, setJsonError]         = useState5(null);

  // snapshot of form at preview time so step 2 is stable even if user edits
  const [previewParentId, setPreviewParentId]     = useState5(null);
  const [previewHistoryPath, setPreviewHistoryPath] = useState5([]);
  const [previewCode, setPreviewCode]             = useState5(null);

  useEffect5(() => {
    Api.get("/v1/definitions?limit=100")
      .then(d => setDefinitions(d.definitions || []))
      .catch(() => {})
      .finally(() => setDefsLoading(false));
  }, []);

  useEffect5(() => {
    if (step !== 3) return;
    const id = setInterval(() => setRealExpiresIn(t => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [step]);

  const fmtMin = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const addEvent = () => {
    if (newEvent.trim()) {
      setHistoryPath([...historyPath, newEvent.trim().toUpperCase()]);
      setNewEvent("");
    }
  };

  function buildBody() {
    let parsed;
    try { parsed = JSON.parse(code); setJsonError(null); }
    catch (e) { throw new Error("Invalid JSON: " + e.message); }
    const body = { id: definitionId.trim(), definition: parsed };
    if (parent) body.parentId = parent;
    if (historyPath.length > 0) body.historyPath = historyPath;
    if (showMapping) {
      const valid = mappings.filter(m => m.old.trim() && m.new.trim());
      if (valid.length > 0)
        body.stateMapping = Object.fromEntries(valid.map(m => [m.old.trim(), m.new.trim()]));
    }
    return body;
  }

  async function handlePreviewImpact() {
    setDeployError(null);
    let body;
    try { body = buildBody(); } catch (e) { setDeployError(e.message); return; }
    setDeploying(true);
    try {
      const res = await Api.put("/v1/definitions?dryRun=true", body);
      setDryRunResult(res);
      setStrandedActors(res.strandedActors || []);
      setDeployResult(null);
      setPreviewParentId(parent);
      setPreviewHistoryPath([...historyPath]);
      setPreviewCode(code);
      setStep(2);
    } catch (e) {
      setDeployError(e.message || "Preview failed");
    } finally {
      setDeploying(false);
    }
  }

  async function handleDeploy() {
    setDeployError(null);
    let body;
    try { body = buildBody(); } catch (e) { setDeployError(e.message); return; }
    setDeploying(true);
    try {
      const res = await Api.put("/v1/definitions", body);
      if (res.status === "requires_confirmation") {
        setStrandedActors(res.strandedActors || []);
        setRealConfirmToken(res.confirmToken);
        setRealExpiresIn(res.expiresIn || 300);
        setDeployResult(null);
        setStep(3);
      } else {
        setDeployResult(res);
        setStrandedActors([]);
        setStep(4);
        pushToast({ kind: "success", title: "Deployed", desc: `${res.affectedActors} actors affected` });
      }
    } catch (e) {
      setDeployError(e.message || "Deploy failed");
    } finally {
      setDeploying(false);
    }
  }

  async function handleConfirmedDeploy() {
    setDeployError(null);
    if (realExpiresIn === 0) { setDeployError("Confirm token expired — go back and re-deploy."); return; }
    let body;
    try { body = buildBody(); } catch (e) { setDeployError(e.message); return; }
    body.confirmToken = realConfirmToken;
    setDeploying(true);
    try {
      const res = await Api.put("/v1/definitions", body);
      setDeployResult(res);
      setStrandedActors([]);
      pushToast({ kind: "success", title: "Deployed", desc: `${res.affectedActors} actors affected, ${res.strandedTagged} tagged needs_rescue` });
      setStep(4);
    } catch (e) {
      setDeployError(e.message || "Confirmed deploy failed");
    } finally {
      setDeploying(false);
    }
  }

  function handleReset() {
    setStep(1); setDeployResult(null); setDryRunResult(null); setStrandedActors([]);
    setRealConfirmToken(null); setRealExpiresIn(300);
    setConfirmed(false); setDeployError(null);
  }

  // ── Derived values for step 2 ─────────────────────────────────────────────

  const previewParentDef = definitions.find(d => d.id === previewParentId);

  // state distribution of would-migrate actors
  const migStateMap = {};
  (dryRunResult?.migration?.wouldMigrate || []).forEach(a => {
    migStateMap[a.currentState] = (migStateMap[a.currentState] || 0) + 1;
  });
  const migStates = Object.entries(migStateMap).sort((a, b) => b[1] - a[1]);
  const migrateCount  = (dryRunResult?.migration?.wouldMigrate || []).length;
  const stayCount     = (dryRunResult?.migration?.wouldStay    || []).length;
  const eligibleCount = dryRunResult?.migration?.eligible || 0;

  // definition diff
  let newStates = [];
  try { newStates = Object.keys(JSON.parse(previewCode || "{}").states || {}); } catch {}
  const parentStates  = previewParentDef?.definitionJson?.states
    ? Object.keys(previewParentDef.definitionJson.states) : [];
  const addedStates   = newStates.filter(s => !parentStates.includes(s));
  const removedStates = parentStates.filter(s => !newStates.includes(s));
  const keptStates    = newStates.filter(s => parentStates.includes(s));

  // transition changes for kept states
  const modifiedStates = [];
  if (previewParentDef && previewCode) {
    try {
      const newDef = JSON.parse(previewCode);
      for (const s of keptStates) {
        const pTrans = Object.keys(previewParentDef.definitionJson.states[s]?.on || {});
        const nTrans = Object.keys(newDef.states?.[s]?.on || {});
        const addedT   = nTrans.filter(t => !pTrans.includes(t));
        const removedT = pTrans.filter(t => !nTrans.includes(t));
        if (addedT.length || removedT.length) modifiedStates.push({ state: s, addedT, removedT });
      }
    } catch {}
  }

  // risk badge
  const hasStranded   = strandedActors.length > 0;
  const migratePct    = eligibleCount > 0 ? migrateCount / eligibleCount : 0;
  let riskLevel, riskColor, riskDesc;
  if (hasStranded) {
    riskLevel = "High"; riskColor = "red";
    riskDesc  = `${strandedActors.reduce((s, a) => s + a.count, 0)} actors will be tagged needs_rescue`;
  } else if (eligibleCount === 0) {
    riskLevel = "None"; riskColor = "muted";
    riskDesc  = previewParentId ? "No actors on parent version yet" : "New definition — no migration";
  } else if (migratePct >= 0.7) {
    riskLevel = "High"; riskColor = "amber";
    riskDesc  = `${Math.round(migratePct * 100)}% of eligible actors will migrate`;
  } else if (migratePct >= 0.3) {
    riskLevel = "Medium"; riskColor = "amber";
    riskDesc  = `${Math.round(migratePct * 100)}% of eligible actors will migrate`;
  } else {
    riskLevel = "Low"; riskColor = "green";
    riskDesc  = eligibleCount > 0
      ? `${Math.round(migratePct * 100)}% of eligible actors will migrate`
      : "No migration needed";
  }

  // historyPath-matched actors (first 8)
  const matchedActors = (dryRunResult?.migration?.wouldMigrate || []).slice(0, 8);

  const parentDef = definitions.find(d => d.id === parent);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Deployment Studio"),
        React.createElement("div", { className: "page-sub" }, "Deploy a new machine version with path-based migration rules")
      ),
      React.createElement("button", { className: "btn btn-ghost", onClick: () => { window.location.hash = "#machines"; } }, "← Back to Machines")
    ),

    React.createElement("div", { className: "deploy-grid" },

      // ── Left panel ────────────────────────────────────────────────────────
      React.createElement("div", { className: "deploy-form" },

        React.createElement("h2", { className: "display", style: { fontSize: 18, margin: "0 0 18px", fontWeight: 600 } }, "Deploy New Version"),

        step < 4 && React.createElement("div", { className: "steps" },
          [1, 2, 3].map(n => React.createElement(React.Fragment, { key: n },
            React.createElement("div", { className: "step" + (step === n ? " active" : step > n ? " done" : "") },
              React.createElement("div", { className: "step-num" }, step > n ? Icons.Check({ size: 12 }) : n),
              React.createElement("span", null, n === 1 ? "Configure" : n === 2 ? "Preview Impact" : "Confirm")
            ),
            n < 3 && React.createElement("div", { className: "step-line" })
          ))
        ),

        deployError && React.createElement("div", {
          style: { padding: "10px 14px", background: "var(--red-bg, #2d1515)", border: "1px solid var(--red-bd, #7f1d1d)", borderRadius: 6, marginBottom: 14, fontSize: 12, color: "var(--red)" }
        }, "⚠ ", deployError),

        // ── STEP 1: Configure ──────────────────────────────────────────────
        step === 1 && React.createElement("div", null,

          React.createElement("label", { className: "field-label" }, "Definition ID"),
          React.createElement("input", {
            className: "input mono", value: definitionId,
            onChange: (e) => setDefinitionId(e.target.value), placeholder: "my-machine-v2"
          }),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4 } }, "Use kebab-case with a version suffix, e.g. loan-v2, ticket-v3"),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" },
            "Parent Definition ", React.createElement("span", { style: { color: "var(--muted)", fontWeight: 400 } }, "(optional — omit for first version)")
          ),
          React.createElement("select", {
            className: "input mono", value: parent,
            onChange: (e) => setParent(e.target.value), disabled: defsLoading
          },
            React.createElement("option", { value: "" }, defsLoading ? "Loading…" : "— none (first version) —"),
            definitions.map(d => React.createElement("option", { key: d.id, value: d.id }, d.id))
          ),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" }, "Definition JSON"),
          React.createElement("textarea", {
            className: "input mono", value: code,
            onChange: (e) => { setCode(e.target.value); setJsonError(null); },
            onBlur: () => {
              try { JSON.parse(code); setJsonError(null); }
              catch (e) { setJsonError(e.message); }
            },
            rows: 18, spellCheck: false,
            style: { resize: "vertical", fontFamily: "JetBrains Mono, monospace", fontSize: 12, lineHeight: 1.5, width: "100%", boxSizing: "border-box" }
          }),
          jsonError
            ? React.createElement("div", { style: { fontSize: 11, marginTop: 4, color: "var(--red)" } }, "⚠ ", jsonError)
            : React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4 } }, "● Valid JSON"),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" },
            "historyPath ", React.createElement("span", { style: { color: "var(--muted)", fontWeight: 400 } }, "(optional — leave empty to target all actors)")
          ),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 } }, "Only actors whose event history matches this sequence will migrate:"),
          React.createElement("div", { className: "event-pills" },
            historyPath.map((e, i) => React.createElement("div", { key: i, className: "event-pill" },
              e,
              React.createElement("span", { className: "x", onClick: () => setHistoryPath(historyPath.filter((_, j) => j !== i)) }, "✕")
            )),
            React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
              React.createElement("input", {
                className: "input mono",
                style: { width: 140, padding: "3px 8px", fontSize: 11 },
                placeholder: "EVENT_NAME", value: newEvent,
                onChange: (e) => setNewEvent(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter") addEvent(); }
              }),
              React.createElement("button", { className: "btn btn-sm", onClick: addEvent }, Icons.Plus({ size: 11 }), " Add")
            )
          ),
          historyPath.length === 0 && React.createElement("div", { style: { fontSize: 11, color: "var(--amber)", marginTop: 6 } },
            "⚠ Wildcard — all active actors on the parent machine are eligible"
          ),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("div", {
            onClick: () => setShowMapping(!showMapping),
            style: { cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 }
          },
            showMapping ? Icons.ChevronDown({ size: 13 }) : Icons.ChevronRight({ size: 13 }),
            "Map renamed states (stateMapping — optional)"
          ),
          showMapping && React.createElement("div", { style: { marginTop: 10, padding: 12, background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)" } },
            React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 8 } }, "Actors stranded in the old state will land in the new state instead of being tagged needs_rescue."),
            mappings.map((m, i) => React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 8, alignItems: "center", marginBottom: 6 } },
              React.createElement("input", {
                className: "input mono", placeholder: "old_state",
                value: m.old, onChange: (e) => { const ms = [...mappings]; ms[i] = { ...ms[i], old: e.target.value }; setMappings(ms); }
              }),
              React.createElement(Icons.ArrowRight, { size: 13, color: "#647080" }),
              React.createElement("input", {
                className: "input mono", placeholder: "new_state",
                value: m.new, onChange: (e) => { const ms = [...mappings]; ms[i] = { ...ms[i], new: e.target.value }; setMappings(ms); }
              }),
              React.createElement("button", { className: "close-x", onClick: () => setMappings(mappings.filter((_, j) => j !== i)) }, Icons.X({ size: 11 }))
            )),
            React.createElement("button", { className: "btn btn-sm btn-ghost", onClick: () => setMappings([...mappings, { old: "", new: "" }]) }, Icons.Plus({ size: 11 }), " Add row")
          ),

          React.createElement("div", { style: { marginTop: 22 } },
            React.createElement("button", {
              className: "btn btn-blue",
              onClick: handlePreviewImpact,
              disabled: deploying || !definitionId.trim()
            }, deploying ? "Analyzing…" : "Preview Impact")
          )
        ),

        // ── STEP 2: Preview Impact ─────────────────────────────────────────
        step === 2 && dryRunResult && React.createElement("div", null,

          // 1. Risk badge
          React.createElement("div", {
            style: {
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 8, marginBottom: 14,
              background: riskColor === "red" ? "var(--red-bg, #2d1515)"
                : riskColor === "amber" ? "var(--amber-bg, #2d1f0a)"
                : riskColor === "green" ? "var(--green-bg, #0d2318)"
                : "var(--bg)",
              border: `1px solid ${riskColor === "red" ? "var(--red-bd, #7f1d1d)"
                : riskColor === "amber" ? "var(--amber-bd, #78350f)"
                : riskColor === "green" ? "var(--green-bd, #166534)"
                : "var(--border)"}`,
            }
          },
            React.createElement("span", { className: "dot dot-" + riskColor, style: { flexShrink: 0 } }),
            React.createElement("div", null,
              React.createElement("div", { style: { fontSize: 12, fontWeight: 700, color: riskColor === "muted" ? "var(--muted)" : `var(--${riskColor})` } },
                riskLevel === "None" ? "No migration" : `${riskLevel} impact`
              ),
              React.createElement("div", { style: { fontSize: 11, color: "var(--muted)", marginTop: 2 } }, riskDesc)
            )
          ),

          // 2. Migration counts
          React.createElement("div", {
            style: { padding: 14, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 }
          },
            React.createElement("div", { style: { fontWeight: 600, fontSize: 12, marginBottom: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" } }, "Migration Impact"),
            React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, textAlign: "center" } },
              React.createElement("div", null,
                React.createElement("div", { className: "mono", style: { fontSize: 22, fontWeight: 700 } }, eligibleCount),
                React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "eligible")
              ),
              React.createElement("div", null,
                React.createElement("div", { className: "mono", style: { fontSize: 22, fontWeight: 700, color: "var(--green)" } }, migrateCount),
                React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "would migrate")
              ),
              React.createElement("div", null,
                React.createElement("div", { className: "mono", style: { fontSize: 22, fontWeight: 700, color: "var(--muted)" } }, stayCount),
                React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "would stay")
              )
            )
          ),

          // 3. State breakdown (actors-by-state for would-migrate)
          migStates.length > 0 && React.createElement("div", {
            style: { padding: 14, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 }
          },
            React.createElement("div", { style: { fontWeight: 600, fontSize: 12, marginBottom: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" } }, "Where are the migrating actors now?"),
            migStates.map(([state, count]) => {
              const pct = migrateCount > 0 ? count / migrateCount : 0;
              return React.createElement("div", { key: state, style: { marginBottom: 8 } },
                React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 11 } },
                  React.createElement("span", { className: "mono" }, state),
                  React.createElement("span", { className: "mono muted" }, count)
                ),
                React.createElement("div", { style: { height: 4, background: "var(--border)", borderRadius: 2 } },
                  React.createElement("div", {
                    style: { height: 4, width: `${Math.round(pct * 100)}%`, background: "var(--green)", borderRadius: 2 }
                  })
                )
              );
            })
          ),

          // 4. historyPath actor preview (only when historyPath was set)
          previewHistoryPath.length > 0 && React.createElement("div", {
            style: { padding: 14, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 }
          },
            React.createElement("div", { style: { fontWeight: 600, fontSize: 12, marginBottom: 8, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" } },
              "Actors matching historyPath"
            ),
            React.createElement("div", { style: { fontSize: 11, color: "var(--muted)", marginBottom: 8 } },
              "Filter: ", previewHistoryPath.map((e, i) => React.createElement("span", { key: i, className: "mono", style: { marginLeft: 4, padding: "1px 5px", background: "var(--border)", borderRadius: 3 } }, e)),
              React.createElement("span", { style: { marginLeft: 8 } }, "→ ", React.createElement("strong", null, migrateCount), " matched")
            ),
            matchedActors.length > 0
              ? React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                  matchedActors.map(a => React.createElement("span", {
                    key: a.actorId, className: "mono",
                    style: { fontSize: 10, padding: "2px 6px", background: "var(--border)", borderRadius: 3, color: "var(--muted)" }
                  }, a.actorId.slice(0, 8) + "…")),
                  migrateCount > 8 && React.createElement("span", { style: { fontSize: 11, color: "var(--muted)", alignSelf: "center" } }, `+ ${migrateCount - 8} more`)
                )
              : React.createElement("div", { style: { fontSize: 11, color: "var(--muted)" } }, "No actors matched this fingerprint sequence yet.")
          ),

          // 5. Stranded warning
          strandedActors.length > 0 && React.createElement("div", {
            style: { padding: 16, background: "var(--amber-bg)", border: "1px solid var(--amber-bd)", borderRadius: 8, marginBottom: 14 }
          },
            React.createElement("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--amber)" } }, "⚠ Breaking change detected"),
            React.createElement("div", { style: { fontSize: 12, color: "var(--muted)", marginTop: 6, marginBottom: 10, lineHeight: 1.5 } },
              "These actor states don't exist in the new definition. Deploying will tag them ",
              React.createElement("span", { style: { color: "var(--red)" } }, "needs_rescue"),
              " — they stop accepting events until a rescue version is deployed."
            ),
            React.createElement("table", { className: "tbl", style: { marginBottom: 0 } },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Stranded State"),
                  React.createElement("th", null, "Actors")
                )
              ),
              React.createElement("tbody", null,
                strandedActors.map((s, i) => React.createElement("tr", { key: i },
                  React.createElement("td", { className: "mono" }, s.currentState),
                  React.createElement("td", null, React.createElement(Pill, { kind: "red" }, s.count))
                ))
              )
            )
          ),

          !strandedActors.length && eligibleCount > 0 && React.createElement("div", {
            style: { padding: 12, background: "var(--green-bg, #0d2318)", border: "1px solid var(--green-bd, #166534)", borderRadius: 8, marginBottom: 14, fontSize: 12, color: "var(--green)" }
          }, "✓ No breaking changes — all current actor states exist in the new definition"),

          React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            React.createElement("button", {
              className: "btn btn-blue", style: { flex: 1 },
              onClick: handleDeploy, disabled: deploying
            }, deploying ? "Deploying…" : strandedActors.length > 0 ? "Deploy (needs confirmation) →" : "Deploy"),
            React.createElement("button", { className: "btn btn-ghost", onClick: handleReset }, "← Edit")
          )
        ),

        // ── STEP 3: Confirm breaking change ───────────────────────────────
        step === 3 && React.createElement("div", null,
          React.createElement("div", { style: { padding: 16, border: "1px solid var(--amber-bd)", background: "var(--amber-bg)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
              React.createElement("div", { style: { fontSize: 12.5, color: "var(--amber)" } }, "Confirm token expires in:"),
              React.createElement("div", { className: "display", style: { fontSize: 22, color: realExpiresIn < 60 ? "var(--red)" : "var(--amber)", fontVariantNumeric: "tabular-nums" } }, fmtMin(realExpiresIn))
            )
          ),
          React.createElement("label", { style: { display: "flex", gap: 10, alignItems: "flex-start", padding: 14, border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" } },
            React.createElement("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked), style: { marginTop: 3 } }),
            React.createElement("div", { style: { fontSize: 12.5, lineHeight: 1.5 } },
              "I understand that ", strandedActors.reduce((s, a) => s + a.count, 0), " actor(s) will be tagged ",
              React.createElement("span", { style: { color: "var(--red)" } }, "needs_rescue"),
              " and will stop accepting events until a rescue version is deployed."
            )
          ),
          React.createElement("button", {
            className: "btn btn-danger",
            disabled: !confirmed || realExpiresIn === 0 || deploying,
            style: { marginTop: 14, width: "100%" },
            onClick: handleConfirmedDeploy
          }, deploying ? "Deploying…" : "Deploy with Rescue Plan"),
          React.createElement("button", { className: "btn btn-ghost", style: { marginTop: 8, width: "100%" }, onClick: () => setStep(2) }, "← Back to Preview")
        ),

        // ── STEP 4: Success ────────────────────────────────────────────────
        step === 4 && deployResult && React.createElement("div", null,
          React.createElement("div", { style: { padding: 16, background: "var(--green-bg, #0d2318)", border: "1px solid var(--green-bd, #166534)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { style: { fontWeight: 600, fontSize: 13, color: "var(--green)" } },
              deployResult.strandedTagged > 0 ? "✓ Deployed with rescue plan" : "✓ Deployed successfully"
            ),
            React.createElement("div", { style: { fontSize: 12, color: "var(--muted)", marginTop: 6, lineHeight: 1.6 } },
              React.createElement("div", null, "Definition: ", React.createElement("span", { className: "mono" }, deployResult.id)),
              React.createElement("div", null, "Affected actors: ", React.createElement("span", { className: "mono" }, deployResult.affectedActors)),
              deployResult.strandedTagged > 0 && React.createElement("div", null, "Tagged needs_rescue: ", React.createElement("span", { style: { color: "var(--red)" } }, deployResult.strandedTagged)),
              deployResult.deploymentId && React.createElement("div", null, "Deployment ID: ", React.createElement("span", { className: "mono", style: { fontSize: 10 } }, deployResult.deploymentId))
            )
          ),
          React.createElement("div", { style: { display: "flex", gap: 8 } },
            deployResult.deploymentId && React.createElement("a", { href: "#migration", className: "btn btn-blue" }, "View in Migration Intel"),
            React.createElement("button", { className: "btn btn-ghost", onClick: handleReset }, "Deploy Another")
          )
        )
      ),

      // ── Right panel ──────────────────────────────────────────────────────
      React.createElement("div", null,
        React.createElement("div", { className: "card", style: { padding: 0, minHeight: 400, display: "flex", flexDirection: "column" } },

          // Step 2: Definition diff view
          step === 2
            ? React.createElement(React.Fragment, null,
                React.createElement("div", { style: { padding: "12px 16px", borderBottom: "1px solid var(--border)" } },
                  React.createElement("div", { className: "display", style: { fontSize: 13, fontWeight: 600 } }, "State Changes"),
                  React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, marginTop: 2 } },
                    (previewParentId || "—"), " → ", definitionId || "—"
                  )
                ),
                React.createElement("div", { style: { flex: 1, padding: "16px 20px", overflowY: "auto" } },

                  // No parent — just show new states
                  !previewParentId && React.createElement("div", null,
                    React.createElement("div", { className: "field-label", style: { marginBottom: 8 } }, "New states (", newStates.length, ")"),
                    React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                      newStates.map(s => React.createElement("span", { key: s, className: "pill mono", style: { fontSize: 10 } }, s))
                    )
                  ),

                  // With parent — show full diff
                  previewParentId && React.createElement("div", null,
                    addedStates.length > 0 && React.createElement("div", { style: { marginBottom: 14 } },
                      React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--green)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 } }, "+ Added"),
                      React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                        addedStates.map(s => React.createElement("span", {
                          key: s, className: "mono",
                          style: { fontSize: 11, padding: "3px 8px", background: "var(--green-bg, #0d2318)", border: "1px solid var(--green-bd, #166534)", borderRadius: 4, color: "var(--green)" }
                        }, s))
                      )
                    ),
                    removedStates.length > 0 && React.createElement("div", { style: { marginBottom: 14 } },
                      React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--red)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 } }, "− Removed"),
                      React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                        removedStates.map(s => React.createElement("span", {
                          key: s, className: "mono",
                          style: { fontSize: 11, padding: "3px 8px", background: "var(--red-bg, #2d1515)", border: "1px solid var(--red-bd, #7f1d1d)", borderRadius: 4, color: "var(--red)" }
                        }, s))
                      )
                    ),
                    modifiedStates.length > 0 && React.createElement("div", { style: { marginBottom: 14 } },
                      React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--amber)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 } }, "~ Modified transitions"),
                      React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                        modifiedStates.map(({ state, addedT, removedT }) =>
                          React.createElement("div", { key: state, style: { padding: "8px 10px", background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)" } },
                            React.createElement("div", { className: "mono", style: { fontSize: 11, fontWeight: 600, marginBottom: 4 } }, state),
                            addedT.map(t => React.createElement("div", { key: t, style: { fontSize: 11, color: "var(--green)" } }, "+ ", t)),
                            removedT.map(t => React.createElement("div", { key: t, style: { fontSize: 11, color: "var(--red)" } }, "− ", t))
                          )
                        )
                      )
                    ),
                    keptStates.filter(s => !modifiedStates.find(m => m.state === s)).length > 0 &&
                      React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 } }, "Unchanged"),
                        React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                          keptStates.filter(s => !modifiedStates.find(m => m.state === s)).map(s =>
                            React.createElement("span", {
                              key: s, className: "mono",
                              style: { fontSize: 11, padding: "3px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--muted)" }
                            }, s)
                          )
                        )
                      )
                  )
                )
              )

            // Steps 1 / 3 / 4: Definition preview (existing)
            : React.createElement(React.Fragment, null,
                React.createElement("div", { style: { padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  React.createElement("div", null,
                    React.createElement("div", { className: "display", style: { fontSize: 13, fontWeight: 600 } }, "Definition preview"),
                    React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, marginTop: 2 } }, parent || "—", " → ", definitionId || "—")
                  )
                ),
                React.createElement("div", { style: { flex: 1, padding: "16px 20px" } },
                  parentDef
                    ? React.createElement("div", null,
                        React.createElement("div", { className: "field-label", style: { marginBottom: 6 } }, "Parent: ", React.createElement("span", { className: "mono", style: { fontWeight: 400 } }, parentDef.id)),
                        parentDef.definitionJson?.states && React.createElement("div", { style: { marginBottom: 12 } },
                          React.createElement("div", { className: "field-label", style: { marginBottom: 6 } }, "Parent states (", Object.keys(parentDef.definitionJson.states).length, ")"),
                          React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                            Object.keys(parentDef.definitionJson.states).map(s => React.createElement("span", { key: s, className: "pill pill-blue mono", style: { fontSize: 10 } }, s))
                          )
                        )
                      )
                    : React.createElement("div", { className: "muted", style: { fontSize: 12 } }, "Select a parent definition to see state diff"),
                  (() => {
                    try {
                      const parsed = JSON.parse(code);
                      const states = parsed.states ? Object.keys(parsed.states) : [];
                      if (states.length === 0) return null;
                      return React.createElement("div", null,
                        React.createElement("div", { className: "field-label", style: { marginBottom: 6, marginTop: 12 } }, "New states (", states.length, ")"),
                        React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                          states.map(s => React.createElement("span", { key: s, className: "pill pill-blue mono", style: { fontSize: 10 } }, s))
                        )
                      );
                    } catch { return null; }
                  })()
                )
              )
        )
      )
    )
  );
}

window.PageDeploy = PageDeploy;
