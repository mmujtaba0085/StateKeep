/* global React, Icons, Pill, EmptyState, useApp, MOCK_WEBHOOKS */
const { useState: useStateX, useMemo: useMemoX } = React;

// ============ Scheduled mock data with full status set ============
const MOCK_SCHEDULED_EVENTS = [
  { id: "sch_01", evt: "EXPIRE",           actor: "a4f2b8c1d6e2", machine: "Loan Application v3",  fireAt: "Apr 27, 14:18 UTC", relTime: "in 2d 14h",  status: "pending" },
  { id: "sch_02", evt: "AUTO_APPROVE",     actor: "a4f2b8c1d6e2", machine: "Loan Application v3",  fireAt: "Apr 25, 06:22 UTC", relTime: "in 6h 12m",  status: "pending" },
  { id: "sch_03", evt: "EXPIRE",           actor: "c7d9e2f4a18b", machine: "Loan Application v3",  fireAt: "Apr 25, 00:11 UTC", relTime: "fired 4h ago", status: "fired" },
  { id: "sch_04", evt: "REMINDER",         actor: "e8f2a4b6c910", machine: "Subscription Mgmt v4", fireAt: "Apr 25, 04:18 UTC", relTime: "in 4h 22m",  status: "pending" },
  { id: "sch_05", evt: "TIMEOUT",          actor: "9c4d8e2a7f31", machine: "Subscription Mgmt v4", fireAt: "Apr 24, 22:08 UTC", relTime: "failed 1h ago", status: "failed" },
  { id: "sch_06", evt: "RENEW",            actor: "d1c3b7a9f2e4", machine: "Subscription Mgmt v4", fireAt: "Apr 24, 21:42 UTC", relTime: "fired 2h ago", status: "fired" },
  { id: "sch_07", evt: "EXPIRE",           actor: "f5e8d2c1b083", machine: "User Onboarding v2",   fireAt: "Apr 27, 23:00 UTC", relTime: "in 47h",     status: "pending" },
  { id: "sch_08", evt: "TIMEOUT",          actor: "7e3a9b1f4c20", machine: "Order Processing v2",  fireAt: "Apr 25, 00:07 UTC", relTime: "in 11m",     status: "pending" },
  { id: "sch_09", evt: "REMINDER",         actor: "5b2e9d7c10af", machine: "Insurance Claims v1",  fireAt: "Apr 24, 19:55 UTC", relTime: "failed 5h ago", status: "failed" },
  { id: "sch_10", evt: "RENEW",            actor: "2a8f6e0b94d3", machine: "Subscription Mgmt v4", fireAt: "Apr 24, 18:30 UTC", relTime: "cancelled",  status: "cancelled" }
];

const STATUS_PILL = {
  pending:   { kind: "amber", label: "pending" },
  fired:     { kind: "green", label: "fired" },
  failed:    { kind: "red",   label: "failed" },
  cancelled: { kind: "muted", label: "cancelled" }
};

function StatusTab({ id, label, count, active, onClick }) {
  return React.createElement("button", {
    className: "tab" + (active ? " active" : ""),
    onClick
  },
    label,
    count != null && React.createElement("span", {
      className: "mono",
      style: { marginLeft: 6, color: "var(--muted)", fontSize: 10.5 }
    }, count)
  );
}

function PageScheduled() {
  const { pushToast } = useApp();
  const [tab, setTab] = useStateX("all");
  const [cancelledIds, setCancelledIds] = useStateX(new Set());

  const events = MOCK_SCHEDULED_EVENTS.map(e =>
    cancelledIds.has(e.id) ? { ...e, status: "cancelled", relTime: "cancelled just now" } : e
  );

  const counts = useMemoX(() => {
    const c = { all: events.length, pending: 0, fired: 0, failed: 0, cancelled: 0 };
    events.forEach(e => { c[e.status] = (c[e.status] || 0) + 1; });
    return c;
  }, [events]);

  const filtered = tab === "all" ? events : events.filter(e => e.status === tab);

  const onCancel = (id) => {
    setCancelledIds(prev => new Set(prev).add(id));
    pushToast({ kind: "info", title: "Scheduled event cancelled", desc: "ID: " + id });
  };

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Scheduled Events"),
        React.createElement("div", { className: "page-sub" }, "Events queued to fire at a future time. ", counts.pending, " pending across all machines.")
      ),
      React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
        React.createElement("span", { className: "muted", style: { fontSize: 11 } },
          "Filter ",
          React.createElement("span", { className: "kbd" }, "/"),
        ),
        React.createElement("button", { className: "btn btn-primary" }, Icons.Plus({ size: 12 }), "Schedule event")
      )
    ),
    React.createElement("div", { className: "toolbar" },
      React.createElement("div", { className: "tab-bar", style: { margin: 0, border: "none" } },
        React.createElement(StatusTab, { id: "all",       label: "All",       count: counts.all,       active: tab === "all",       onClick: () => setTab("all") }),
        React.createElement(StatusTab, { id: "pending",   label: "Pending",   count: counts.pending,   active: tab === "pending",   onClick: () => setTab("pending") }),
        React.createElement(StatusTab, { id: "fired",     label: "Fired",     count: counts.fired,     active: tab === "fired",     onClick: () => setTab("fired") }),
        React.createElement(StatusTab, { id: "failed",    label: "Failed",    count: counts.failed,    active: tab === "failed",    onClick: () => setTab("failed") }),
        React.createElement(StatusTab, { id: "cancelled", label: "Cancelled", count: counts.cancelled, active: tab === "cancelled", onClick: () => setTab("cancelled") })
      ),
      React.createElement("div", { className: "grow" }),
      React.createElement("div", { className: "results-count" }, "Showing ", filtered.length, " of ", events.length)
    ),
    React.createElement("div", { style: { padding: "14px 28px 28px" } },
      filtered.length === 0
        ? React.createElement("div", { className: "card" },
            React.createElement(EmptyState, {
              title: "No scheduled events",
              desc: "Nothing is queued in this view. Schedule one from an actor, or via the API.",
              action: React.createElement("button", { className: "btn btn-primary", style: { marginTop: 8 } }, Icons.Plus({ size: 12 }), "Schedule event")
            })
          )
        : React.createElement("div", { className: "card", style: { padding: 0 } },
            React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Actor"),
                  React.createElement("th", null, "Event"),
                  React.createElement("th", null, "Machine"),
                  React.createElement("th", null, "Fires at"),
                  React.createElement("th", null, "Status"),
                  React.createElement("th", { style: { width: 130, textAlign: "right" } }, "Actions")
                )
              ),
              React.createElement("tbody", null,
                filtered.map(s => {
                  const pill = STATUS_PILL[s.status];
                  return React.createElement("tr", { key: s.id, style: { cursor: "default" } },
                    React.createElement("td", { className: "mono truncate", style: { maxWidth: 160 }, title: s.actor }, s.actor),
                    React.createElement("td", null, React.createElement(Pill, { kind: "blue" }, s.evt)),
                    React.createElement("td", { className: "muted" }, s.machine),
                    React.createElement("td", null,
                      React.createElement("div", { className: "mono", style: { fontSize: 11.5 } }, s.fireAt),
                      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5 } }, s.relTime)
                    ),
                    React.createElement("td", null, React.createElement(Pill, { kind: pill.kind }, pill.label)),
                    React.createElement("td", { style: { textAlign: "right" } },
                      s.status === "pending"
                        ? React.createElement("button", { className: "btn btn-sm btn-ghost", onClick: () => onCancel(s.id) }, "Cancel")
                        : React.createElement("span", { className: "muted", style: { fontSize: 11 } }, "—")
                    )
                  );
                })
              )
            )
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
  const { setModal, pushToast } = useApp();
  const [extra, setExtra] = useStateX([]);
  const [pinging, setPinging] = useStateX(null);
  const [deactivated, setDeactivated] = useStateX(new Set());

  const rows = [...MOCK_WEBHOOKS, ...extra].map((w, i) => ({
    ...w,
    _id: w._id || ("wh_" + i),
    active: deactivated.has(w._id || ("wh_" + i)) ? false : w.active
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
                rows.map(w => React.createElement("tr", { key: w._id, style: { cursor: "default" } },
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
