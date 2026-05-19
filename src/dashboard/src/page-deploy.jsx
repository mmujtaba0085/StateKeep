/* global React, Icons, Pill, Api, useApp */
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
  const [parent, setParent] = useState5("");
  const [code, setCode] = useState5(SAMPLE_JSON);
  const [historyPath, setHistoryPath] = useState5(["START_APPLICATION", "SUBMIT", "PAY_FEE"]);
  const [newEvent, setNewEvent] = useState5("");
  const [showMapping, setShowMapping] = useState5(false);
  const [mappings, setMappings] = useState5([{ old: "awaiting_documents", new: "awaiting_docs" }]);
  const [token, setToken] = useState5(292);
  const [confirmed, setConfirmed] = useState5(false);
  const [definitions, setDefinitions] = useState5([]);
  const [defsLoading, setDefsLoading] = useState5(true);

  useEffect5(() => {
    Api.get("/v1/definitions?limit=50")
      .then(d => {
        const defs = d.definitions || [];
        setDefinitions(defs);
        if (defs.length > 0) setParent(defs[0].id);
      })
      .catch(() => {})
      .finally(() => setDefsLoading(false));
  }, []);

  useEffect5(() => {
    if (step !== 3) return;
    const id = setInterval(() => setToken(t => Math.max(0, t - 1)), 1000);
    return () => clearInterval(id);
  }, [step]);

  const parentDef = definitions.find(d => d.id === parent);
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
          React.createElement("select", {
            className: "input mono",
            value: parent,
            onChange: (e) => setParent(e.target.value),
            disabled: defsLoading
          },
            defsLoading
              ? React.createElement("option", null, "Loading…")
              : definitions.length === 0
                ? React.createElement("option", { value: "" }, "No definitions found")
                : definitions.map(d => React.createElement("option", { key: d.id, value: d.id },
                    d.id + ((d._actorCount || 0) > 0 ? " · " + (d._actorCount || 0).toLocaleString() + " active" : "")
                  ))
          ),
          React.createElement("div", { className: "mono", style: { fontSize: 11, marginTop: 6, color: "var(--blue)" } },
            parentDef
              ? React.createElement(React.Fragment, null,
                  "Inheriting from ", parent, " (",
                  (parentDef._actorCount || 0).toLocaleString(), " active actors)"
                )
              : React.createElement("span", { style: { color: "var(--muted)" } }, "Select a parent definition above")
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
          React.createElement("div", { style: { padding: 16, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "flex-start" } },
              Icons.Box({ size: 16, color: "var(--muted)" }),
              React.createElement("div", null,
                React.createElement("div", { style: { fontWeight: 600, fontSize: 12.5 } }, "Impact preview not available"),
                React.createElement("div", { style: { color: "var(--muted)", fontSize: 11.5, marginTop: 4, lineHeight: 1.6 } },
                  "Migration counts (migrate / stay / rescue) are computed by the APV engine at deploy time. Once confirmed, live results will appear in the Migration Monitor."
                )
              )
            )
          ),
          parentDef && React.createElement("div", { style: { padding: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 14 } },
            React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 } }, "PARENT DEFINITION"),
            React.createElement("div", { className: "mono", style: { fontSize: 12 } },
              React.createElement("div", null, React.createElement("span", { style: { color: "var(--muted)" } }, "id  "), parentDef.id),
              React.createElement("div", { style: { marginTop: 4 } }, React.createElement("span", { style: { color: "var(--muted)" } }, "actors  "), (parentDef._actorCount || 0).toLocaleString(), " active"),
              parentDef.machineId && React.createElement("div", { style: { marginTop: 4 } }, React.createElement("span", { style: { color: "var(--muted)" } }, "machine  "), parentDef.machineId)
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
              "I understand that actors whose current state does not exist in the new definition will be tagged ",
              React.createElement("span", { style: { color: "var(--red)" } }, "needs_rescue"),
              ". These actors will remain frozen until a rescue version is deployed or they are manually reset."
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
              React.createElement("div", { className: "display", style: { fontSize: 13, fontWeight: 600 } }, "Definition preview"),
              React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, marginTop: 2 } }, parent || "—", " → ", definitionId)
            )
          ),
          React.createElement("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--muted)", padding: 24 } },
            Icons.Box({ size: 32, color: "var(--border)" }),
            parentDef
              ? React.createElement(React.Fragment, null,
                  React.createElement("div", { style: { fontSize: 13, fontWeight: 500, color: "var(--text)" } }, parentDef.id),
                  React.createElement("div", { style: { fontSize: 11, textAlign: "center", lineHeight: 1.6 } },
                    (parentDef._actorCount || 0).toLocaleString(), " active actors",
                    parentDef.machineId ? " · " + parentDef.machineId : ""
                  ),
                  parentDef.definitionJson?.states && React.createElement("div", { style: { marginTop: 6, fontSize: 11, color: "var(--blue)", fontFamily: "JetBrains Mono, monospace" } },
                    Object.keys(parentDef.definitionJson.states).length, " states"
                  )
                )
              : React.createElement("div", { style: { fontSize: 12 } }, "Select a parent definition"),
            React.createElement("div", { style: { fontSize: 11, marginTop: 4, opacity: 0.6 } }, "State diagram preview not available")
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
