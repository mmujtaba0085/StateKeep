/* global React, Icons, Pill, StateDiagram, useApp,
   MOCK_MACHINES, STATES_BY_FAMILY */
const { useState: useState5, useEffect: useEffect5, useMemo: useMemo5 } = React;

function syntaxHighlight(code) {
  // Minimal JSON-ish syntax highlighting (returns array of tokens)
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"') {
      let end = code.indexOf('"', i + 1);
      while (end !== -1 && code[end - 1] === "\\") end = code.indexOf('"', end + 1);
      if (end === -1) end = code.length;
      const str = code.slice(i, end + 1);
      // Is this a key? (followed by colon)
      let j = end + 1;
      while (j < code.length && /\s/.test(code[j])) j++;
      tokens.push({ t: code[j] === ":" ? "key" : "string", v: str });
      i = end + 1;
    } else if (/[0-9.-]/.test(c) && (i === 0 || /[\s,:\[\{]/.test(code[i - 1]))) {
      let j = i;
      while (j < code.length && /[0-9.-]/.test(code[j])) j++;
      tokens.push({ t: "num", v: code.slice(i, j) });
      i = j;
    } else if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < code.length && /[a-zA-Z]/.test(code[j])) j++;
      const w = code.slice(i, j);
      tokens.push({ t: (w === "true" || w === "false" || w === "null") ? "bool" : "plain", v: w });
      i = j;
    } else {
      tokens.push({ t: /[{}\[\]:,]/.test(c) ? "punct" : "plain", v: c });
      i++;
    }
  }
  return tokens.map((tok, k) => React.createElement("span", { key: k, className: tok.t === "plain" ? undefined : "tok-" + tok.t }, tok.v));
}

const SAMPLE_JSON = `{
  "id": "loan-v3",
  "parent": "loan-v2",
  "initial": "idle",
  "states": {
    "idle":          { "on": { "START_APPLICATION": "application" } },
    "application":   { "on": { "SUBMIT": "underwriting" } },
    "underwriting":  { "on": {
      "PAY_FEE":   "income_verify",
      "WAIVE_FEE": "awaiting_docs"
    } },
    "income_verify": { "on": { "INCOME_VERIFIED": "awaiting_docs" } },
    "awaiting_docs": { "on": {
      "APPROVE": "approved",
      "REJECT":  "rejected"
    } },
    "approved": { "type": "final" },
    "rejected": { "type": "final" }
  }
}`;

function PageDeploy() {
  const [step, setStep] = useState5(1);
  const [definitionId, setDefinitionId] = useState5("loan-v3");
  const [parent, setParent] = useState5("loan-v2");
  const [code, setCode] = useState5(SAMPLE_JSON);
  const [historyPath, setHistoryPath] = useState5(["START_APPLICATION", "SUBMIT", "PAY_FEE"]);
  const [newEvent, setNewEvent] = useState5("");
  const [showMapping, setShowMapping] = useState5(false);
  const [mappings, setMappings] = useState5([{ old: "awaiting_documents", new: "awaiting_docs" }]);
  const [token, setToken] = useState5(292);
  const [confirmed, setConfirmed] = useState5(false);

  useEffect5(() => {
    if (step !== 3) return;
    const id = setInterval(() => setToken(t => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [step]);

  const parentMachine = MOCK_MACHINES.find(m => m.versions.some(v => v.id === parent));
  const parentStates = parentMachine ? (STATES_BY_FAMILY[parentMachine.family] || STATES_BY_FAMILY.loan) : STATES_BY_FAMILY.loan;
  const newStates = STATES_BY_FAMILY.loan;

  const fmtMin = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  const addEvent = () => {
    if (newEvent.trim()) {
      setHistoryPath([...historyPath, newEvent.trim().toUpperCase()]);
      setNewEvent("");
    }
  };

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Deployment Studio"),
        React.createElement("div", { className: "page-sub" }, "Deploy a new machine version with path-based migration rules")
      ),
      React.createElement("button", { className: "btn btn-ghost", onClick: () => { window.location.hash = "#machines"; } }, "← Back to Machines")
    ),
    React.createElement("div", { className: "deploy-grid" },
      // Left form
      React.createElement("div", { className: "deploy-form" },
        React.createElement("h2", { className: "display", style: { fontSize: 18, margin: "0 0 18px", fontWeight: 600 } }, "Deploy New Version"),
        React.createElement("div", { className: "steps" },
          [1, 2, 3].map(n => React.createElement(React.Fragment, { key: n },
            React.createElement("div", { className: "step" + (step === n ? " active" : step > n ? " done" : "") },
              React.createElement("div", { className: "step-num" }, step > n ? Icons.Check({ size: 12 }) : n),
              React.createElement("span", null, n === 1 ? "Configure" : n === 2 ? "Review Impact" : "Confirm")
            ),
            n < 3 && React.createElement("div", { className: "step-line" })
          ))
        ),

        step === 1 && React.createElement("div", null,
          React.createElement("label", { className: "field-label" }, "Definition ID"),
          React.createElement("input", { className: "input mono", value: definitionId, onChange: (e) => setDefinitionId(e.target.value) }),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4 } }, "Suggested: loan-v3, loan-v3-beta"),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" }, "Parent Definition"),
          React.createElement("select", { className: "input mono", value: parent, onChange: (e) => setParent(e.target.value) },
            MOCK_MACHINES.flatMap(m => m.versions.map(v => React.createElement("option", { key: v.id, value: v.id },
              v.id + " · " + v.active.toLocaleString() + " active")))
          ),
          React.createElement("div", { className: "mono", style: { fontSize: 11, marginTop: 6, color: "var(--blue)" } },
            "Inheriting from ", parent, " (",
            (parentMachine?.versions.find(v => v.id === parent)?.active || 0).toLocaleString(), " active actors)"
          ),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" }, "Definition JSON"),
          React.createElement("div", {
            className: "code-editor",
            contentEditable: false,
            spellCheck: false
          }, syntaxHighlight(code)),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4, display: "flex", justifyContent: "space-between" } },
            React.createElement("span", null,
              React.createElement("span", { style: { color: "var(--green)" } }, "● "),
              "valid JSON · 7 states · 7 transitions"
            ),
            React.createElement("span", null, "lines: ", code.split("\n").length)
          ),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("label", { className: "field-label" }, "historyPath"),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 } },
            "Target actors who have processed these events (in order):"),
          React.createElement("div", { className: "event-pills" },
            historyPath.map((e, i) => React.createElement("div", { key: i, className: "event-pill" },
              e,
              React.createElement("span", { className: "x", onClick: () => setHistoryPath(historyPath.filter((_, j) => j !== i)) }, "✕")
            )),
            React.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
              React.createElement("input", {
                className: "input mono",
                style: { width: 140, padding: "3px 8px", fontSize: 11 },
                placeholder: "EVENT_NAME",
                value: newEvent,
                onChange: (e) => setNewEvent(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter") addEvent(); }
              }),
              React.createElement("button", { className: "btn btn-sm", onClick: addEvent }, Icons.Plus({ size: 11 }), "Add")
            )
          ),
          historyPath.length === 0 && React.createElement("div", { style: { fontSize: 11, color: "var(--amber)", marginTop: 6 } },
            "⚠ Wildcard — all actors on parent are eligible"
          ),

          React.createElement("div", { style: { height: 14 } }),
          React.createElement("div", { onClick: () => setShowMapping(!showMapping), style: { cursor: "pointer", display: "flex", alignItems: "center", gap: 6, color: "var(--muted)", fontSize: 12 } },
            showMapping ? Icons.ChevronDown({ size: 13 }) : Icons.ChevronRight({ size: 13 }),
            "Map renamed states (optional)"
          ),
          showMapping && React.createElement("div", { style: { marginTop: 10, padding: 12, background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)" } },
            mappings.map((m, i) => React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1fr auto 1fr auto", gap: 8, alignItems: "center", marginBottom: 6 } },
              React.createElement("select", { className: "input mono" }, React.createElement("option", null, m.old)),
              React.createElement(Icons.ArrowRight, { size: 13, color: "#647080" }),
              React.createElement("select", { className: "input mono" }, React.createElement("option", null, m.new)),
              React.createElement("button", { className: "close-x", onClick: () => setMappings(mappings.filter((_, j) => j !== i)) }, Icons.X({ size: 11 }))
            )),
            React.createElement("button", { className: "btn btn-sm btn-ghost", onClick: () => setMappings([...mappings, { old: "", new: "" }]) }, Icons.Plus({ size: 11 }), "Add row")
          ),

          React.createElement("div", { style: { marginTop: 22 } },
            React.createElement("button", { className: "btn btn-blue", onClick: () => setStep(2) }, "Preview Impact"),
            React.createElement("button", { className: "btn btn-ghost", style: { marginLeft: 8 } }, "Save draft")
          )
        ),

        step === 2 && React.createElement("div", null,
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 } },
            React.createElement("div", { className: "stat-tile green" },
              React.createElement("div", { className: "stat-tile-label" }, "Will migrate"),
              React.createElement("div", { className: "stat-tile-val" }, "2,891")
            ),
            React.createElement("div", { className: "stat-tile amber" },
              React.createElement("div", { className: "stat-tile-label" }, "Will stay"),
              React.createElement("div", { className: "stat-tile-val" }, "1,312")
            )
          ),
          React.createElement("div", { style: { padding: 14, background: "var(--amber-bg)", border: "1px solid var(--amber-bd)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "flex-start" } },
              Icons.AlertTriangle({ size: 14, color: "#f59e0b" }),
              React.createElement("div", { style: { flex: 1 } },
                React.createElement("div", { style: { fontWeight: 600, color: "var(--amber)", fontSize: 12.5 } }, "70 actors are stranded"),
                React.createElement("div", { style: { color: "var(--muted)", fontSize: 11.5, marginTop: 4, lineHeight: 1.55 } },
                  "These will be tagged needs_rescue. They are in states that do not exist in the new definition."),
                React.createElement("div", { style: { marginTop: 10, display: "flex", gap: 6 } },
                  React.createElement(Pill, { kind: "red" }, "cancelled · 70"))
              )
            )
          ),
          React.createElement("div", { style: { padding: 14, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 8 } }, "MINI SANKEY — destinations"),
            React.createElement("div", { className: "mono", style: { fontSize: 11.5, lineHeight: 1.8 } },
              React.createElement("div", null,
                React.createElement("span", { style: { color: "var(--green)" } }, "● 2,891 → loan-v3"),
                React.createElement("div", { style: { background: "var(--green)", height: 8, width: (2891/4273*100)+"%", borderRadius: 2, marginTop: 4 } })
              ),
              React.createElement("div", { style: { marginTop: 6 } },
                React.createElement("span", { style: { color: "var(--amber)" } }, "● 1,312 → loan-v2 (stayed)"),
                React.createElement("div", { style: { background: "var(--amber)", height: 8, width: (1312/4273*100)+"%", borderRadius: 2, marginTop: 4 } })
              ),
              React.createElement("div", { style: { marginTop: 6 } },
                React.createElement("span", { style: { color: "var(--red)" } }, "● 70 → needs_rescue"),
                React.createElement("div", { style: { background: "var(--red)", height: 8, width: (70/4273*100)+"%", borderRadius: 2, marginTop: 4 } })
              )
            )
          ),
          React.createElement("button", { className: "btn btn-primary", style: { width: "100%" }, onClick: () => setStep(3) }, "Confirm Deploy"),
          React.createElement("button", { className: "btn btn-ghost", style: { marginTop: 8, width: "100%" }, onClick: () => setStep(1) }, "Back")
        ),

        step === 3 && React.createElement("div", null,
          React.createElement("div", { style: { padding: 16, border: "1px solid var(--amber-bd)", background: "var(--amber-bg)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
              React.createElement("div", { style: { fontSize: 12.5, color: "var(--amber)" } }, "Confirm token expires in:"),
              React.createElement("div", { className: "display", style: { fontSize: 22, color: "var(--amber)", fontVariantNumeric: "tabular-nums" } }, fmtMin(token))
            )
          ),
          React.createElement("label", { style: { display: "flex", gap: 10, alignItems: "flex-start", padding: 14, border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" } },
            React.createElement("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked), style: { marginTop: 3 } }),
            React.createElement("div", { style: { fontSize: 12.5, lineHeight: 1.5 } },
              "I understand that ",
              React.createElement("span", { style: { color: "var(--red)" } }, "70 actors will be tagged needs_rescue"),
              ". These actors will remain frozen until I deploy a rescue version or reset them."
            )
          ),
          React.createElement("button", {
            className: "btn btn-danger",
            disabled: !confirmed || token === 0,
            style: { marginTop: 14, width: "100%" }
          }, "Deploy with Rescue Plan"),
          React.createElement("button", { className: "btn btn-ghost", style: { marginTop: 8, width: "100%" }, onClick: () => setStep(2) }, "Back")
        )
      ),
      // Right preview
      React.createElement("div", null,
        React.createElement("div", { className: "card", style: { padding: 0, height: 540, display: "flex", flexDirection: "column" } },
          React.createElement("div", { style: { padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" } },
            React.createElement("div", null,
              React.createElement("div", { className: "display", style: { fontSize: 13, fontWeight: 600 } }, "Live preview"),
              React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, marginTop: 2 } }, parent, " → ", definitionId)
            ),
            React.createElement("div", { style: { display: "flex", gap: 6, fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } },
              React.createElement("span", { style: { color: "var(--green)" } }, "+ added"),
              React.createElement("span", { style: { color: "var(--red)" } }, "− removed"),
              React.createElement("span", { style: { color: "var(--amber)" } }, "~ changed")
            )
          ),
          React.createElement("div", { style: { flex: 1, minHeight: 0 } },
            React.createElement(StateDiagram, { data: newStates, showCounts: false })
          ),
          React.createElement("div", { style: { padding: "10px 16px", borderTop: "1px solid var(--border)", fontSize: 11 } },
            React.createElement("div", { className: "diff-add" }, "+ income_verify (new state, between underwriting and awaiting_docs)"),
            React.createElement("div", { className: "diff-chg", style: { marginTop: 3 } }, "~ underwriting transitions: split PAY_FEE / WAIVE_FEE")
          )
        )
      )
    )
  );
}

window.PageDeploy = PageDeploy;
