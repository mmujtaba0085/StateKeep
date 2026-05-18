/* global React, Icons, Pill, EmptyState, useApp, Api */
const { useState: useStateX, useEffect: useEffectX, useMemo: useMemoX } = React;

function PageScheduled() {
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Scheduled Events"),
        React.createElement("div", { className: "page-sub" }, "Events queued to fire at a future time")
      ),
      React.createElement("button", { className: "btn btn-primary" }, Icons.Plus({ size: 12 }), "Schedule event")
    ),
    React.createElement("div", { style: { padding: "14px 28px 28px" } },
      React.createElement("div", { className: "card" },
        React.createElement(EmptyState, {
          title: "No scheduled events",
          desc: "Schedule an event from an actor's detail drawer, or via POST /v1/actors/:id/event with a delay parameter.",
          action: React.createElement("button", { className: "btn btn-primary", style: { marginTop: 8 } }, Icons.Plus({ size: 12 }), "Schedule event")
        })
      )
    )
  );
}

// ============ Webhooks ============
const ALL_EVENTS = [
  "actor.transitioned",
  "actor.terminated",
  "actor.rescue",
  "deployment.started",
  "deployment.completed",
  "migration.completed",
  "worker.restarted"
];

function RegisterWebhookForm({ onCancel, onSubmit }) {
  const [url, setUrl] = useStateX("");
  const [secret, setSecret] = useStateX("");
  const [picked, setPicked] = useStateX(new Set(["actor.transitioned"]));

  const toggle = (e) => {
    const next = new Set(picked);
    next.has(e) ? next.delete(e) : next.add(e);
    setPicked(next);
  };

  return React.createElement(React.Fragment, null,
    React.createElement("div", null,
      React.createElement("label", { className: "field-label" }, "Endpoint URL"),
      React.createElement("input", {
        className: "input mono",
        placeholder: "https://api.example.com/webhooks/statekeep",
        value: url, onChange: (e) => setUrl(e.target.value)
      })
    ),
    React.createElement("div", { style: { marginTop: 14 } },
      React.createElement("label", { className: "field-label" }, "Subscribed events"),
      React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        ALL_EVENTS.map(e => {
          const on = picked.has(e);
          return React.createElement("button", {
            key: e,
            className: "event-pill",
            onClick: () => toggle(e),
            style: on
              ? { background: "var(--blue-bg)", borderColor: "var(--blue-bd)", color: "var(--blue)", cursor: "pointer" }
              : { background: "var(--surface2)", borderColor: "var(--border)", color: "var(--muted)", cursor: "pointer" }
          },
            on ? Icons.Check({ size: 10 }) : null,
            e
          );
        })
      )
    ),
    React.createElement("div", { style: { marginTop: 14 } },
      React.createElement("label", { className: "field-label" }, "Signing secret"),
      React.createElement("input", {
        className: "input mono",
        placeholder: "whsec_...",
        value: secret, onChange: (e) => setSecret(e.target.value)
      }),
      React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 6 } },
        "Used to sign payloads with HMAC-SHA256."
      )
    )
  );
}

function PageWebhooks() {
  const { setModal, pushToast, apiKey } = useApp();
  const [webhooks, setWebhooks] = useStateX([]);
  const [loadingWh, setLoadingWh] = useStateX(false);
  const [extra, setExtra] = useStateX([]);
  const [pinging, setPinging] = useStateX(null);
  const [deactivated, setDeactivated] = useStateX(new Set());

  useEffectX(() => {
    if (!apiKey) return;
    setLoadingWh(true);
    Api.get("/v1/webhooks")
      .then(data => setWebhooks((data.webhooks || []).map(w => Api.mapWebhook(w))))
      .catch(() => {})
      .finally(() => setLoadingWh(false));
  }, [apiKey]);

  const baseRows = webhooks.length > 0 ? webhooks : [];
  const rows = [...baseRows, ...extra].map((w, i) => ({
    ...w,
    _id: w.id || w._id || ("wh_" + i),
    active: deactivated.has(w.id || w._id || ("wh_" + i)) ? false : w.active
  }));

  const active = rows.filter(r => r.active).length;
  const inactive = rows.length - active;
  const totalFails = rows.reduce((s, r) => s + r.failures, 0);

  const onRegister = () => {
    let formState = { url: "", events: ["actor.transitioned"], secret: "" };
    setModal({
      title: "Register webhook",
      body: React.createElement(RegisterWebhookForm, {
        onCancel: () => setModal(null),
        onSubmit: () => {}
      }),
      footer: React.createElement(React.Fragment, null,
        React.createElement("button", { className: "btn btn-ghost", onClick: () => setModal(null) }, "Cancel"),
        React.createElement("button", {
          className: "btn btn-primary",
          onClick: () => {
            setExtra(prev => [...prev, {
              _id: "wh_new_" + Date.now(),
              url: "https://hooks.example.com/new-endpoint",
              events: ["actor.transitioned"],
              active: true,
              failures: 0,
              lastDelivery: "just now"
            }]);
            setModal(null);
            pushToast({ kind: "success", title: "Webhook registered", desc: "Sending a test ping..." });
          }
        }, "Register webhook")
      )
    });
  };

  const onPing = (id, url) => {
    setPinging(id);
    setTimeout(() => {
      setPinging(null);
      pushToast({ kind: "success", title: "Ping delivered · 200 OK", desc: url });
    }, 700);
  };

  const onToggle = (id, currentlyActive) => {
    setDeactivated(prev => {
      const next = new Set(prev);
      currentlyActive ? next.add(id) : next.delete(id);
      return next;
    });
    pushToast({ kind: "info", title: currentlyActive ? "Webhook deactivated" : "Webhook reactivated" });
  };

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Webhooks"),
        React.createElement("div", { className: "page-sub" }, "Push system events to external endpoints. Payloads are HMAC-signed.")
      ),
      React.createElement("button", { className: "btn btn-primary", onClick: onRegister },
        Icons.Plus({ size: 12 }), "Register webhook"
      )
    ),
    React.createElement("div", { style: { padding: "20px 28px" } },
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 18 } },
        React.createElement("div", { className: "stat-tile green" },
          React.createElement("div", { className: "stat-tile-label" }, "Active endpoints"),
          React.createElement("div", { className: "stat-tile-val" }, active),
          React.createElement("div", { className: "stat-tile-sub" }, inactive, " deactivated")
        ),
        React.createElement("div", { className: "stat-tile blue" },
          React.createElement("div", { className: "stat-tile-label" }, "Deliveries · 24h"),
          React.createElement("div", { className: "stat-tile-val" }, "12,847"),
          React.createElement("div", { className: "stat-tile-sub" }, "average 142/min")
        ),
        React.createElement("div", { className: "stat-tile red" },
          React.createElement("div", { className: "stat-tile-label" }, "Failures · 24h"),
          React.createElement("div", { className: "stat-tile-val" }, totalFails),
          React.createElement("div", { className: "stat-tile-sub" }, totalFails > 0 ? "most from legacy.meridian.fi" : "all endpoints healthy")
        )
      ),
      rows.length === 0
        ? React.createElement("div", { className: "card" },
            React.createElement(EmptyState, {
              title: "No webhooks registered",
              desc: "Subscribe an HTTPS endpoint to receive events as they happen.",
              action: React.createElement("button", { className: "btn btn-primary", style: { marginTop: 8 }, onClick: onRegister }, Icons.Plus({ size: 12 }), "Register webhook")
            })
          )
        : React.createElement("div", { className: "card", style: { padding: 0 } },
            React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Endpoint"),
                  React.createElement("th", null, "Events"),
                  React.createElement("th", null, "Status"),
                  React.createElement("th", { style: { width: 90 } }, "Failures"),
                  React.createElement("th", { style: { width: 120 } }, "Last delivery"),
                  React.createElement("th", { style: { width: 200, textAlign: "right" } }, "Actions")
                )
              ),
              React.createElement("tbody", null,
                !apiKey
                  ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Set your API key in the sidebar to load webhooks"))
                  : loadingWh
                  ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Loading…"))
                  : rows.map(w => React.createElement("tr", { key: w._id, style: { cursor: "default" } },
                  React.createElement("td", null,
                    React.createElement("div", { className: "mono truncate", title: w.url, style: { maxWidth: 320 } }, w.url)
                  ),
                  React.createElement("td", null,
                    React.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                      w.events.map(e => React.createElement(Pill, { kind: "blue", key: e }, e))
                    )
                  ),
                  React.createElement("td", null,
                    React.createElement(Pill, { kind: w.active ? "green" : "muted" },
                      React.createElement("span", { className: "dot dot-" + (w.active ? "green" : "dim") }),
                      w.active ? "active" : "inactive"
                    )
                  ),
                  React.createElement("td", null,
                    w.failures > 0
                      ? React.createElement(Pill, { kind: w.failures > 50 ? "red" : "amber" }, w.failures)
                      : React.createElement("span", { className: "muted mono", style: { fontSize: 11 } }, "0")
                  ),
                  React.createElement("td", { className: "muted mono", style: { fontSize: 11 } }, w.lastDelivery),
                  React.createElement("td", { style: { textAlign: "right" } },
                    React.createElement("div", { style: { display: "inline-flex", gap: 6 } },
                      React.createElement("button", {
                        className: "btn btn-sm btn-ghost",
                        disabled: pinging === w._id || !w.active,
                        onClick: () => onPing(w._id, w.url)
                      }, pinging === w._id ? "Pinging..." : "Ping"),
                      React.createElement("button", {
                        className: "btn btn-sm " + (w.active ? "btn-ghost" : ""),
                        onClick: () => onToggle(w._id, w.active),
                        style: w.active ? {} : { color: "var(--green)", borderColor: "var(--green-bd)", background: "var(--green-bg)" }
                      }, w.active ? "Deactivate" : "Activate")
                    )
                  )
                ))
              )
            )
          )
    )
  );
}

window.PageScheduled = PageScheduled;
window.PageWebhooks = PageWebhooks;
