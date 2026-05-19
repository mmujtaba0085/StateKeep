/* global React, ReactDOM, Api,
   AppProvider, useApp, Sidebar, Toasts, Modal,
   PageLogin, PageCommand, PageActors, PageMigration, PageMachines, PageDeploy,
   PageWorkers, PageMetrics, PageSettings, PageScheduled, PageWebhooks */

function Router() {
  const { route } = useApp();
  switch (route) {
    case "command":   return React.createElement(PageCommand, null);
    case "actors":    return React.createElement(PageActors, null);
    case "migration": return React.createElement(PageMigration, null);
    case "machines":  return React.createElement(PageMachines, null);
    case "deploy":    return React.createElement(PageDeploy, null);
    case "workers":   return React.createElement(PageWorkers, null);
    case "metrics":   return React.createElement(PageMetrics, null);
    case "settings":  return React.createElement(PageSettings, null);
    case "scheduled": return React.createElement(PageScheduled, null);
    case "webhooks":  return React.createElement(PageWebhooks, null);
    default:          return React.createElement(PageCommand, null);
  }
}

function App() {
  const [authed, setAuthed] = React.useState(() => !!Api.key);

  React.useEffect(() => {
    return Api.onChange(k => setAuthed(!!k));
  }, []);

  if (!authed) {
    return React.createElement(PageLogin, null);
  }

  return React.createElement(AppProvider, null,
    React.createElement("div", { className: "app" },
      React.createElement(Sidebar, null),
      React.createElement("main", { className: "main" },
        React.createElement(Router, null)
      ),
      React.createElement(Toasts, null),
      React.createElement(Modal, null)
    )
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App, null));
