/* global React, Api */
const { useState: useStateL, useEffect: useEffectL } = React;

function PageLogin() {
  const [username, setUsername] = useStateL("");
  const [password, setPassword] = useStateL("");
  const [error, setError] = useStateL(null);
  const [loading, setLoading] = useStateL(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      Api.setKey(data.apiKey);
    } catch {
      setError("Cannot reach server — check your connection");
    } finally {
      setLoading(false);
    }
  };

  return React.createElement("div", { className: "login-wrap" },
    React.createElement("div", { className: "login-card" },
      // Logo + branding
      React.createElement("div", { className: "login-brand" },
        React.createElement("svg", { width: 36, height: 36, viewBox: "0 0 24 24", fill: "none" },
          React.createElement("rect", { x: 2, y: 2, width: 13, height: 13, rx: 2, stroke: "#3ecf8e", strokeWidth: 1.6 }),
          React.createElement("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2, stroke: "#3ecf8e", strokeWidth: 1.6, fill: "#3ecf8e", fillOpacity: 0.12 })
        ),
        React.createElement("div", null,
          React.createElement("div", { className: "login-brand-name" }, "StateKeep"),
          React.createElement("div", { className: "login-brand-sub" }, "Mission Control")
        )
      ),
      React.createElement("h1", { className: "login-title" }, "Sign in"),
      React.createElement("p", { className: "login-desc" }, "Enter your dashboard credentials to continue"),
      React.createElement("form", { onSubmit, className: "login-form" },
        React.createElement("div", { className: "login-field" },
          React.createElement("label", { className: "field-label" }, "Username"),
          React.createElement("input", {
            className: "input",
            type: "text",
            autoComplete: "username",
            autoFocus: true,
            placeholder: "admin",
            value: username,
            onChange: (e) => setUsername(e.target.value),
            disabled: loading
          })
        ),
        React.createElement("div", { className: "login-field" },
          React.createElement("label", { className: "field-label" }, "Password"),
          React.createElement("input", {
            className: "input",
            type: "password",
            autoComplete: "current-password",
            placeholder: "••••••••••••••••",
            value: password,
            onChange: (e) => setPassword(e.target.value),
            disabled: loading
          })
        ),
        error && React.createElement("div", { className: "login-error" },
          React.createElement("span", { style: { color: "var(--red)", fontSize: 12 } }, error)
        ),
        React.createElement("button", {
          type: "submit",
          className: "btn btn-primary login-submit",
          disabled: loading || !username.trim() || !password
        }, loading ? "Signing in…" : "Sign in")
      ),
      React.createElement("div", { className: "login-footer" },
        React.createElement("span", { className: "muted", style: { fontSize: 11 } },
          "Credentials are set by the server administrator"
        )
      )
    )
  );
}

window.PageLogin = PageLogin;
