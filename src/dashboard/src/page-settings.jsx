/* global React, Icons, Pill, useApp, Api */
const { useState: useState7, useEffect: useEffect7 } = React;

function PageSettings() {
  const [section, setSection] = useState7("instance");
  const sections = [
    { id: "instance", label: "Instance" },
    { id: "webhooks", label: "Webhooks" },
    { id: "danger",   label: "Danger Zone" }
  ];

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Settings"),
        React.createElement("div", { className: "page-sub" }, "Instance info, webhooks, and configuration")
      )
    ),
    React.createElement("div", { className: "settings-grid" },
      React.createElement("div", { className: "settings-nav" },
        sections.map(s => React.createElement("div", {
          key: s.id,
          className: "settings-nav-item" + (section === s.id ? " active" : ""),
          onClick: () => setSection(s.id)
        }, s.label))
      ),
      React.createElement("div", { className: "settings-content" },
        section === "instance"  && React.createElement(InstanceSection, null),
        section === "webhooks"  && React.createElement(WebhooksSection, null),
        section === "danger"    && React.createElement(DangerSection, null)
      )
    )
  );
}

function InstanceSection() {
  const [health, setHealth] = useState7(null);

  useEffect7(() => {
    Api.get("/v1/health").then(setHealth).catch(() => {});
  }, []);

  const uptime = health?.uptime
    ? (health.uptime >= 3600
        ? Math.floor(health.uptime / 3600) + "h " + Math.floor((health.uptime % 3600) / 60) + "m"
        : health.uptime >= 60
        ? Math.floor(health.uptime / 60) + "m"
        : health.uptime + "s")
    : "—";

  const row = (label, value, mono) => React.createElement("div", {
    style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--border)" }
  },
    React.createElement("div", { style: { fontSize: 13, color: "var(--muted)" } }, label),
    React.createElement("div", { className: mono ? "mono" : "", style: { fontSize: 13 } }, value || "—")
  );

  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Instance"),
      React.createElement("div", { className: "card", style: { padding: "0 16px" } },
        row("API status",  health ? React.createElement(Pill, { kind: health.status === "ok" ? "green" : "red" }, health.status) : "loading…"),
        row("APV engine",  health?.engine ? React.createElement(Pill, { kind: health.engine === "wasm" || health.engine === "real" ? "green" : "amber" }, health.engine) : "loading…"),
        row("Database",    health?.db ? React.createElement(Pill, { kind: health.db === "ok" ? "green" : "red" }, health.db) : "loading…"),
        React.createElement("div", {
          style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }
        },
          React.createElement("div", { style: { fontSize: 13, color: "var(--muted)" } }, "Uptime"),
          React.createElement("div", { className: "mono", style: { fontSize: 13 } }, uptime)
        )
      )
    ),
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "API Keys"),
      React.createElement("div", { className: "card", style: { padding: "16px", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 } },
        "Create and rotate API keys via ",
        React.createElement("span", { className: "mono" }, "POST /v1/keys"),
        ". Keys are stored as bcrypt hashes — the raw value is only returned once at creation time.",
        React.createElement("br", null),
        "Admin operations (worker restart, etc.) require ",
        React.createElement("span", { className: "mono" }, "STATEKEEP_ADMIN_KEY"),
        " passed as ",
        React.createElement("span", { className: "mono" }, "x-admin-key"),
        " header."
      )
    )
  );
}

function WebhooksSection() {
  const [webhooks, setWebhooks] = useState7([]);
  const [loading, setLoading] = useState7(false);

  useEffect7(() => {
    setLoading(true);
    Api.get("/v1/webhooks")
      .then(data => setWebhooks((data.webhooks || []).map(w => Api.mapWebhook(w))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        React.createElement("h3", { style: { margin: 0 } }, "Webhooks"),
        React.createElement("a", { href: "#webhooks", className: "btn btn-primary" }, Icons.Plus({ size: 12 }), "Manage webhooks")
      ),
      loading
        ? React.createElement("div", { className: "card", style: { padding: "20px", color: "var(--muted)", fontSize: 12 } }, "Loading…")
        : webhooks.length === 0
        ? React.createElement("div", { className: "card", style: { padding: "20px", color: "var(--muted)", fontSize: 12 } }, "No webhooks registered. Use the Webhooks page to register endpoints.")
        : React.createElement("div", { className: "card", style: { padding: 0 } },
            React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Endpoint"),
                  React.createElement("th", null, "Status"),
                  React.createElement("th", null, "Failures"),
                  React.createElement("th", null, "Last delivery")
                )
              ),
              React.createElement("tbody", null,
                webhooks.map(w => React.createElement("tr", { key: w.id, style: { cursor: "default" } },
                  React.createElement("td", { className: "mono", style: { maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, w.url),
                  React.createElement("td", null, React.createElement(Pill, { kind: w.active ? "green" : "muted" }, w.active ? "active" : "inactive")),
                  React.createElement("td", null,
                    w.failures > 0
                      ? React.createElement(Pill, { kind: w.failures > 50 ? "red" : "amber" }, w.failures)
                      : React.createElement("span", { className: "muted mono", style: { fontSize: 11 } }, "0")
                  ),
                  React.createElement("td", { className: "muted mono", style: { fontSize: 11 } }, w.lastDelivery)
                ))
              )
            )
          )
    )
  );
}

function DangerSection() {
  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Danger Zone"),
      React.createElement("div", { className: "danger-card" },
        React.createElement("h3", null, "Wipe all data"),
        React.createElement("div", { className: "muted", style: { fontSize: 12, marginBottom: 12 } },
          "Permanently deletes all machine definitions, actor state, event history, and webhook registrations. ",
          React.createElement("span", { style: { color: "var(--red)" } }, "This cannot be undone. "),
          "Stop the server and delete the database file directly instead of using this UI control."
        ),
        React.createElement("button", { className: "btn btn-danger", disabled: true }, "Wipe all data (not implemented)")
      )
    )
  );
}

window.PageSettings = PageSettings;
