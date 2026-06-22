/* global React, Icons, Pill, useApp, Api */
const { useState: useState7, useEffect: useEffect7 } = React;

function PageSettings() {
  const [section, setSection] = useState7("organisation");
  const { pushToast, setModal } = useApp();
  const sections = [
    { id: "organisation", label: "Organisation" },
    { id: "webhooks",     label: "Webhooks" },
    { id: "notifications",label: "Notifications" },
    { id: "danger",       label: "Danger Zone" }
  ];

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Settings"),
        React.createElement("div", { className: "page-sub" }, "Organisation, keys, webhooks, and configuration")
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
        section === "organisation" && React.createElement(OrgSection, null),
        section === "webhooks" && React.createElement(WebhooksSection, null),
        section === "notifications" && React.createElement(NotificationsSection, null),
        section === "danger" && React.createElement(DangerSection, null)
      )
    )
  );
}

function OrgSection() {
  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Organisation"),
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 720 } },
        React.createElement("div", null,
          React.createElement("label", { className: "field-label" }, "Org name"),
          React.createElement("input", { className: "input", placeholder: "Your organisation name" })
        ),
        React.createElement("div", null,
          React.createElement("label", { className: "field-label" }, "Billing email"),
          React.createElement("input", { className: "input", placeholder: "billing@example.com" })
        ),
        React.createElement("div", null,
          React.createElement("label", { className: "field-label" }, "Region"),
          React.createElement("select", { className: "input" },
            React.createElement("option", null, "EU-WEST (Dublin)"),
            React.createElement("option", null, "US-EAST (Virginia)")
          )
        )
      ),
      React.createElement("div", { style: { marginTop: 14 } },
        React.createElement("button", { className: "btn btn-blue" }, "Save changes")
      )
    ),
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Plan & usage"),
      React.createElement("div", { className: "card", style: { maxWidth: 720, padding: "20px", color: "var(--muted)", fontSize: 12 } },
        "Plan details and usage quotas will be shown here once billing is configured."
      )
    )
  );
}

function KeysSection({ pushToast, setModal, apiKey }) {
  const openCreate = () => {
    let draftLabel = "";
    let draftTier = "free";
    setModal({
      title: "Create API Key",
      body: React.createElement("div", null,
        React.createElement("label", { className: "field-label" }, "Label"),
        React.createElement("input", {
          className: "input",
          placeholder: "e.g. CI / Deploy / Production",
          autoFocus: true,
          onChange: (e) => { draftLabel = e.target.value; }
        }),
        React.createElement("div", { style: { height: 12 } }),
        React.createElement("label", { className: "field-label" }, "Tier"),
        React.createElement("select", {
          className: "input",
          onChange: (e) => { draftTier = e.target.value; }
        },
          React.createElement("option", { value: "free" }, "Free"),
          React.createElement("option", { value: "enterprise" }, "Enterprise")
        ),
        React.createElement("div", { style: { marginTop: 14, padding: 12, background: "var(--amber-bg)", border: "1px solid var(--amber-bd)", borderRadius: 6 } },
          React.createElement("div", { style: { color: "var(--amber)", fontWeight: 600, fontSize: 12 } }, "Save this key now"),
          React.createElement("div", { style: { fontSize: 11.5, color: "var(--muted)", marginTop: 4 } }, "The raw key is shown exactly once and never stored.")
        )
      ),
      footer: React.createElement(React.Fragment, null,
        React.createElement("button", { className: "btn btn-ghost", onClick: () => setModal(null) }, "Cancel"),
        React.createElement("button", {
          className: "btn btn-primary",
          onClick: async () => {
            if (!draftLabel.trim()) { pushToast({ kind: "error", title: "Label required" }); return; }
            setModal(null);
            try {
              const res = await Api.post("/v1/keys", { label: draftLabel.trim(), tier: draftTier });
              setModal({
                title: "API Key Created — Copy Now",
                body: React.createElement("div", null,
                  React.createElement("div", { style: { marginBottom: 10, fontSize: 12, color: "var(--muted)" } }, "This key will not be shown again."),
                  React.createElement("div", { className: "input mono", style: { padding: "10px 12px", fontSize: 12, wordBreak: "break-all", background: "var(--bg)", userSelect: "all" } }, res.rawKey),
                  React.createElement("div", { style: { marginTop: 8, fontSize: 11, color: "var(--muted)" } }, "Label: ", res.label, " · Tier: ", res.tier, " · ID: ", res.keyId)
                ),
                footer: React.createElement("button", {
                  className: "btn btn-primary",
                  onClick: () => {
                    navigator.clipboard?.writeText(res.rawKey).catch(() => {});
                    pushToast({ kind: "success", title: "Key copied to clipboard" });
                    setModal(null);
                  }
                }, "Copy & Close")
              });
            } catch (e) {
              pushToast({ kind: "error", title: "Failed to create key", desc: e.message });
            }
          }
        }, "Create key")
      )
    });
  };

  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        React.createElement("h3", { style: { margin: 0 } }, "API Keys"),
        apiKey && React.createElement("button", { className: "btn btn-primary", onClick: openCreate }, Icons.Plus({ size: 12 }), " Create new key")
      ),
      !apiKey
        ? React.createElement("div", { className: "card", style: { padding: "20px", color: "var(--muted)", fontSize: 12 } },
            "Set your API key in the sidebar to manage keys."
          )
        : React.createElement("div", { className: "card", style: { padding: "20px", color: "var(--muted)", fontSize: 12 } },
            "Click \"Create new key\" above to generate an additional API key via ", React.createElement("span", { className: "mono" }, "POST /v1/keys"), "."
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

function NotificationsSection() {
  const items = [
    { name: "Deployment completed", desc: "When a new definition finishes deploying", channels: ["email","slack"] },
    { name: "Migration failure", desc: "When any actor fails to migrate", channels: ["email","slack","webhook"] },
    { name: "Worker stale", desc: "When a worker exceeds the 120s heartbeat threshold", channels: ["email"] },
    { name: "Quota at 80%", desc: "When approaching actor or event limit", channels: ["email"] },
    { name: "Webhook failure", desc: "When a webhook endpoint returns 5xx repeatedly", channels: [] }
  ];
  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Notifications"),
      React.createElement("div", { className: "card", style: { padding: 0 } },
        items.map((it, i) => React.createElement("div", { key: i, style: { padding: "14px 18px", borderBottom: i < items.length - 1 ? "1px solid var(--border)" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" } },
          React.createElement("div", null,
            React.createElement("div", { style: { fontWeight: 500, fontSize: 13 } }, it.name),
            React.createElement("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, it.desc)
          ),
          React.createElement("div", { style: { display: "flex", gap: 6 } },
            ["email","slack","webhook"].map(c => {
              const on = it.channels.includes(c);
              return React.createElement(Pill, { key: c, kind: on ? "blue" : "muted" }, c);
            })
          )
        ))
      )
    )
  );
}

function DangerSection() {
  return React.createElement("div", null,
    React.createElement("div", { className: "settings-section" },
      React.createElement("h3", null, "Danger Zone"),
      React.createElement("div", { className: "danger-card" },
        React.createElement("h3", null, "Delete organisation"),
        React.createElement("div", { className: "muted", style: { fontSize: 12, marginBottom: 12 } },
          "This will permanently delete the organisation, all machine definitions, and all actor state. ",
          React.createElement("span", { style: { color: "var(--red)" } }, "This action cannot be undone.")
        ),
        React.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
          React.createElement("input", { className: "input", placeholder: 'Type your org name to confirm', style: { maxWidth: 360 } }),
          React.createElement("button", { className: "btn btn-danger" }, "Delete organisation")
        )
      )
    )
  );
}

window.PageSettings = PageSettings;
