/* global React, Api */
const { useState: useStateL } = React;

function PageLogin() {
  const [apiKey, setApiKey]   = useStateL("");
  const [show, setShow]       = useStateL(false);
  const [error, setError]     = useStateL(null);
  const [orgName, setOrgName] = useStateL(null);
  const [loading, setLoading] = useStateL(false);

  const trimmed = apiKey.trim();

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setOrgName(null);
    try {
      const res = await fetch("/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invalid API key — check and try again");
        return;
      }
      setOrgName(data.label || "instance");
      // Brief confirmation flash before entering the app
      setTimeout(() => Api.setKey(trimmed), 600);
    } catch {
      setError("Cannot reach server — check your connection");
    } finally {
      setLoading(false);
    }
  };

  return React.createElement("div", { className: "login-wrap" },
    React.createElement("div", { className: "login-card" },

      // ── Brand ─────────────────────────────────────────────────────────────
      React.createElement("div", { className: "login-brand" },
        React.createElement("svg", { width: 34, height: 34, viewBox: "0 0 24 24", fill: "none" },
          React.createElement("rect", { x: 2, y: 2, width: 13, height: 13, rx: 2,
            stroke: "#3ecf8e", strokeWidth: 1.6 }),
          React.createElement("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2,
            stroke: "#3ecf8e", strokeWidth: 1.6, fill: "#3ecf8e", fillOpacity: 0.12 })
        ),
        React.createElement("div", null,
          React.createElement("div", { className: "login-brand-name" }, "StateKeep"),
          React.createElement("div", { className: "login-brand-sub" }, "Mission Control")
        )
      ),

      React.createElement("h1", { className: "login-title" }, "Sign in"),
      React.createElement("p", { className: "login-desc" },
        "Paste your API key to access the dashboard"
      ),

      // ── Form ───────────────────────────────────────────────────────────────
      React.createElement("form", { onSubmit, className: "login-form" },
        React.createElement("div", { className: "login-field" },
          React.createElement("label", { className: "field-label" }, "API Key"),
          React.createElement("div", { style: { position: "relative" } },
            React.createElement("input", {
              className: "input",
              type: show ? "text" : "password",
              autoFocus: true,
              placeholder: "sk_live_••••••••••••••••••••••••••••••••",
              value: apiKey,
              onChange: (e) => { setApiKey(e.target.value); setError(null); setOrgName(null); },
              disabled: loading,
              style: { paddingRight: 44, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: show ? 0 : 2 },
              spellCheck: false,
              autoComplete: "off",
            }),
            React.createElement("button", {
              type: "button",
              onClick: () => setShow(s => !s),
              style: {
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer",
                color: "var(--muted)", padding: 2, lineHeight: 1,
              },
              title: show ? "Hide key" : "Show key",
            },
              show
                ? React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
                    React.createElement("path", { d: "M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" }),
                    React.createElement("path", { d: "M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" }),
                    React.createElement("line", { x1: 1, y1: 1, x2: 23, y2: 23 })
                  )
                : React.createElement("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
                    React.createElement("path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }),
                    React.createElement("circle", { cx: 12, cy: 12, r: 3 })
                  )
            )
          )
        ),

        // ── Error / success feedback ─────────────────────────────────────────
        error && React.createElement("div", { className: "login-error" },
          React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
            stroke: "var(--red)", strokeWidth: 2, style: { flexShrink: 0 } },
            React.createElement("circle", { cx: 12, cy: 12, r: 10 }),
            React.createElement("line", { x1: 12, y1: 8, x2: 12, y2: 12 }),
            React.createElement("line", { x1: 12, y1: 16, x2: 12.01, y2: 16 })
          ),
          React.createElement("span", null, error)
        ),

        orgName && React.createElement("div", { className: "login-success" },
          React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
            stroke: "var(--green)", strokeWidth: 2.5, style: { flexShrink: 0 } },
            React.createElement("polyline", { points: "20 6 9 17 4 12" })
          ),
          React.createElement("span", null, "Verified — loading dashboard…")
        ),

        React.createElement("button", {
          type: "submit",
          className: "btn btn-primary login-submit",
          disabled: loading || !trimmed,
        }, loading ? "Verifying…" : "Enter dashboard")
      ),

      // ── Footer hint ────────────────────────────────────────────────────────
      React.createElement("div", { className: "login-footer" },
        React.createElement("span", { className: "muted", style: { fontSize: 11 } },
          "Find your key in .env (STATEKEEP_API_KEY) or create one via POST /v1/keys."
        )
      )
    )
  );
}

window.PageLogin = PageLogin;
