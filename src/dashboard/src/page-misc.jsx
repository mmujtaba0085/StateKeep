/* global React, Icons, Pill, EmptyState, useApp, Api */
const { useState: useStateX, useEffect: useEffectX } = React;

// ============ Scheduled ============
function PageScheduled() {
  const { apiKey } = useApp();
  const [items, setItems] = useStateX([]);
  const [loading, setLoading] = useStateX(true);

  useEffectX(() => {
    if (!apiKey) return;
    Api.get("/v1/scheduled")
      .then(d => setItems(d.scheduled || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [apiKey]);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Scheduled Events"),
        React.createElement("div", { className: "page-sub" }, "Events queued to fire at a future time")
      )
    ),
    React.createElement("div", { style: { padding: "14px 28px 28px" } },
      React.createElement("div", { className: "card", style: loading || items.length === 0 ? {} : { padding: 0 } },
        loading
          ? React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "Loading…")
          : items.length === 0
          ? React.createElement(EmptyState, {
              title: "No scheduled events",
              desc: "Schedule an event from an actor's detail view via POST /v1/actors/:id/schedule."
            })
          : React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Actor"),
                  React.createElement("th", null, "Event"),
                  React.createElement("th", null, "Fire at"),
                  React.createElement("th", null, "Status")
                )
              ),
              React.createElement("tbody", null,
                items.map(s => React.createElement("tr", { key: s.id },
                  React.createElement("td", { className: "mono", style: { fontSize: 11 } }, s.actorId),
                  React.createElement("td", null, React.createElement(Pill, { kind: "blue" }, s.eventType)),
                  React.createElement("td", { className: "mono muted", style: { fontSize: 11 } },
                    new Date(s.fireAt).toLocaleString()
                  ),
                  React.createElement("td", null, React.createElement(Pill, { kind: s.status === "pending" ? "amber" : "green" }, s.status))
                ))
              )
            )
      )
    )
  );
}

// ============ Webhooks ============
const VALID_EVENTS = [
  "state.changed",
  "actor.migrated",
  "actor.terminated",
  "actor.needs_rescue",
  "scheduled.fired",
  "scheduled.failed",
];

function RegisterWebhookForm({ onChange }) {
  const [url, setUrl]       = useStateX("");
  const [secret, setSecret] = useStateX("");
  const [picked, setPicked] = useStateX(new Set(["state.changed"]));

  const toggle = (e) => {
    const next = new Set(picked);
    next.has(e) ? next.delete(e) : next.add(e);
    setPicked(next);
    onChange({ url, secret, events: [...next] });
  };

  const onUrl    = (v) => { setUrl(v);    onChange({ url: v,    secret, events: [...picked] }); };
  const onSecret = (v) => { setSecret(v); onChange({ url, secret: v, events: [...picked] }); };

  return React.createElement(React.Fragment, null,
    React.createElement("div", null,
      React.createElement("label", { className: "field-label" }, "Endpoint URL"),
      React.createElement("input", {
        className: "input mono",
        placeholder: "https://api.example.com/hooks/statekeep",
        value: url,
        onChange: (e) => onUrl(e.target.value),
      }),
      React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4 } }, "Must be HTTPS.")
    ),
    React.createElement("div", { style: { marginTop: 14 } },
      React.createElement("label", { className: "field-label" }, "Signing secret"),
      React.createElement("input", {
        className: "input mono",
        placeholder: "min 16 characters",
        value: secret,
        onChange: (e) => onSecret(e.target.value),
      }),
      React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 4 } },
        "Used to sign payloads with HMAC-SHA256. Save it — not stored in plain text."
      )
    ),
    React.createElement("div", { style: { marginTop: 14 } },
      React.createElement("label", { className: "field-label" }, "Subscribed events"),
      React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        VALID_EVENTS.map(e => {
          const on = picked.has(e);
          return React.createElement("button", {
            key: e,
            type: "button",
            className: "event-pill",
            onClick: () => toggle(e),
            style: on
              ? { background: "var(--blue-bg)", borderColor: "var(--blue-bd)", color: "var(--blue)", cursor: "pointer" }
              : { background: "var(--surface2)", borderColor: "var(--border)", color: "var(--muted)", cursor: "pointer" }
          }, on ? Icons.Check({ size: 10 }) : null, " ", e);
        })
      )
    )
  );
}

function PageWebhooks() {
  const { setModal, pushToast, apiKey } = useApp();
  const [webhooks, setWebhooks] = useStateX([]);
  const [loading, setLoading]   = useStateX(false);
  const [saving, setSaving]     = useStateX(null);

  const reload = () => {
    if (!apiKey) return;
    setLoading(true);
    Api.get("/v1/webhooks")
      .then(data => setWebhooks((data.webhooks || []).map(w => Api.mapWebhook(w))))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffectX(() => { reload(); }, [apiKey]);

  const active      = webhooks.filter(w => w.active).length;
  const inactive    = webhooks.length - active;
  const totalFails  = webhooks.reduce((s, w) => s + (w.failures || 0), 0);

  // worst offender label
  const worstLabel = () => {
    if (totalFails === 0) return "all endpoints healthy";
    const worst = [...webhooks].sort((a, b) => (b.failures || 0) - (a.failures || 0))[0];
    try {
      return "most from " + new URL(worst.url).hostname;
    } catch {
      return "check endpoint health";
    }
  };

  const onRegister = () => {
    let draft = { url: "", secret: "", events: ["state.changed"] };
    setModal({
      title: "Register webhook",
      body: React.createElement(RegisterWebhookForm, {
        onChange: (v) => { draft = v; }
      }),
      footer: React.createElement(React.Fragment, null,
        React.createElement("button", { className: "btn btn-ghost", onClick: () => setModal(null) }, "Cancel"),
        React.createElement("button", {
          className: "btn btn-primary",
          onClick: async () => {
            if (!draft.url.startsWith("https://")) {
              pushToast({ kind: "error", title: "URL must be HTTPS" }); return;
            }
            if (draft.secret.length < 16) {
              pushToast({ kind: "error", title: "Secret must be at least 16 characters" }); return;
            }
            if (draft.events.length === 0) {
              pushToast({ kind: "error", title: "Select at least one event type" }); return;
            }
            try {
              await Api.post("/v1/webhooks", { url: draft.url, secret: draft.secret, events: draft.events });
              setModal(null);
              pushToast({ kind: "success", title: "Webhook registered" });
              reload();
            } catch (err) {
              pushToast({ kind: "error", title: "Registration failed", desc: err.message });
            }
          }
        }, "Register webhook")
      )
    });
  };

  const onPing = async (id, url) => {
    setSaving(id + "_ping");
    try {
      const { deliveryId } = await Api.post("/v1/webhooks/" + id + "/ping", {});
      pushToast({ kind: "info", title: "Ping queued — checking delivery…", desc: url });
      // Webhook worker polls every 2s. Wait 2.5s then check result.
      setTimeout(async () => {
        try {
          const data = await Api.get("/v1/webhooks/" + id + "/deliveries?limit=5");
          const delivery = (data.deliveries || []).find(d => d.id === deliveryId);
          if (delivery?.status === "delivered") {
            pushToast({ kind: "success", title: "Ping delivered ✓", desc: `HTTP ${delivery.responseCode} — ${url}` });
          } else if (delivery?.status === "failed") {
            pushToast({ kind: "error", title: "Ping failed", desc: delivery.error || `HTTP ${delivery.responseCode || "?"}` });
          } else {
            pushToast({ kind: "info", title: "Ping in queue", desc: "Delivery pending — check the deliveries list" });
          }
        } catch {}
      }, 2500);
    } catch (err) {
      pushToast({ kind: "error", title: "Ping failed", desc: err.message });
    } finally {
      setSaving(null);
    }
  };

  const onRemove = async (id, url) => {
    if (!window.confirm(`Remove webhook?\n${url}\n\nThis deletes all delivery history and cannot be undone.`)) return;
    setSaving(id + "_remove");
    try {
      await Api.delete("/v1/webhooks/" + id);
      setWebhooks(ws => ws.filter(w => w.id !== id));
      pushToast({ kind: "success", title: "Webhook removed" });
    } catch (err) {
      pushToast({ kind: "error", title: "Remove failed", desc: err.message });
    } finally {
      setSaving(null);
    }
  };

  const onToggle = async (id, currentlyActive) => {
    setSaving(id + "_toggle");
    try {
      await Api.patch("/v1/webhooks/" + id, { active: !currentlyActive });
      pushToast({ kind: "info", title: currentlyActive ? "Webhook deactivated" : "Webhook activated" });
      reload();
    } catch (err) {
      pushToast({ kind: "error", title: "Update failed", desc: err.message });
    } finally {
      setSaving(null);
    }
  };

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Webhooks"),
        React.createElement("div", { className: "page-sub" }, "Push system events to external endpoints. Payloads are HMAC-signed.")
      ),
      React.createElement("button", { className: "btn btn-primary", onClick: onRegister },
        Icons.Plus({ size: 12 }), " Register webhook"
      )
    ),
    React.createElement("div", { style: { padding: "20px 28px" } },
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 18 } },
        React.createElement("div", { className: "stat-tile green" },
          React.createElement("div", { className: "stat-tile-label" }, "Active endpoints"),
          React.createElement("div", { className: "stat-tile-val" }, active),
          React.createElement("div", { className: "stat-tile-sub" }, inactive + " deactivated")
        ),
        React.createElement("div", { className: "stat-tile blue" },
          React.createElement("div", { className: "stat-tile-label" }, "Total endpoints"),
          React.createElement("div", { className: "stat-tile-val" }, webhooks.length),
          React.createElement("div", { className: "stat-tile-sub" }, active + " active, " + inactive + " inactive")
        ),
        React.createElement("div", { className: "stat-tile " + (totalFails > 0 ? "red" : "green") },
          React.createElement("div", { className: "stat-tile-label" }, "Total failures"),
          React.createElement("div", { className: "stat-tile-val" }, totalFails),
          React.createElement("div", { className: "stat-tile-sub" }, worstLabel())
        )
      ),

      loading
        ? React.createElement("div", { className: "card" },
            React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "Loading…")
          )
        : webhooks.length === 0
        ? React.createElement("div", { className: "card" },
            React.createElement(EmptyState, {
              title: "No webhooks registered",
              desc: "Subscribe an HTTPS endpoint to receive events as they happen.",
              action: React.createElement("button", {
                className: "btn btn-primary", style: { marginTop: 8 }, onClick: onRegister
              }, Icons.Plus({ size: 12 }), " Register webhook")
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
                  React.createElement("th", { style: { width: 260, textAlign: "right" } }, "Actions")
                )
              ),
              React.createElement("tbody", null,
                webhooks.map(w => React.createElement("tr", { key: w.id },
                  React.createElement("td", null,
                    React.createElement("div", { className: "mono truncate", title: w.url, style: { maxWidth: 320 } }, w.url)
                  ),
                  React.createElement("td", null,
                    React.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                      (w.events || []).map(e => React.createElement(Pill, { kind: "blue", key: e }, e))
                    )
                  ),
                  React.createElement("td", null,
                    React.createElement(Pill, { kind: w.active ? "green" : "muted" },
                      React.createElement("span", { className: "dot dot-" + (w.active ? "green" : "dim") }),
                      " ", w.active ? "active" : "inactive"
                    )
                  ),
                  React.createElement("td", null,
                    (w.failures || 0) > 0
                      ? React.createElement(Pill, { kind: (w.failures || 0) > 50 ? "red" : "amber" }, w.failures)
                      : React.createElement("span", { className: "muted mono", style: { fontSize: 11 } }, "0")
                  ),
                  React.createElement("td", { className: "muted mono", style: { fontSize: 11 } }, w.lastDelivery),
                  React.createElement("td", { style: { textAlign: "right" } },
                    React.createElement("div", { style: { display: "inline-flex", gap: 6 } },
                      React.createElement("button", {
                        className: "btn btn-sm btn-ghost",
                        disabled: saving === w.id + "_ping" || !w.active,
                        onClick: () => onPing(w.id, w.url)
                      }, saving === w.id + "_ping" ? "Pinging…" : "Ping"),
                      React.createElement("button", {
                        className: "btn btn-sm " + (w.active ? "btn-ghost" : ""),
                        disabled: saving === w.id + "_toggle",
                        onClick: () => onToggle(w.id, w.active),
                        style: w.active ? {} : { color: "var(--green)", borderColor: "var(--green-bd)", background: "var(--green-bg)" }
                      }, saving === w.id + "_toggle" ? "…" : w.active ? "Deactivate" : "Activate"),
                      React.createElement("button", {
                        className: "btn btn-sm",
                        disabled: saving === w.id + "_remove",
                        onClick: () => onRemove(w.id, w.url),
                        style: { color: "var(--red, #ef4444)", borderColor: "var(--red-bd, #fca5a5)", background: "var(--red-bg, #fef2f2)" }
                      }, saving === w.id + "_remove" ? "…" : "Remove")
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
