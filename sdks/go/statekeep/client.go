// Package statekeep is a Go client for the StateKeep API, plus helpers for webhook
// verification and for serving remote guards/actions (docs/remote-implementations.md).
//
//	sk := statekeep.New("http://localhost:3001", os.Getenv("STATEKEEP_API_KEY"))
//	a, err := sk.Spawn(ctx, "loan", map[string]any{"amount": 50000})
//	a, err = sk.Send(ctx, a.ID, "SUBMIT", map[string]any{"documents": 3})
package statekeep

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client talks to one StateKeep server. Safe for concurrent use.
type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

// New returns a client with a 30s timeout.
func New(baseURL, apiKey string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), APIKey: apiKey, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// Error is returned for non-2xx responses.
type Error struct {
	Status  int
	Code    string // e.g. ACTOR_TERMINATED, ACTOR_NEEDS_RESCUE
	Message string
	Body    map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("statekeep: HTTP %d: %s", e.Status, e.Message) }

// IsCode reports whether err is a StateKeep error with the given code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

// Actor is an actor snapshot. StateValue is a string, or a nested map for compound/parallel states.
type Actor struct {
	ID           string         `json:"id"`
	ActorID      string         `json:"actorId"`
	DefinitionID string         `json:"definitionId"`
	StateValue   any            `json:"stateValue"`
	Status       string         `json:"status"`
	Context      map[string]any `json:"context"`
	Done         bool           `json:"done"`
	MigratedTo   *string        `json:"migratedTo"`
	Idempotent   bool           `json:"idempotent"`
	RequestedAs  string         `json:"requestedAs"`
}

// State returns StateValue as a string when it is a simple (non-nested) state.
func (a *Actor) State() string { s, _ := a.StateValue.(string); return s }

// Key returns the actor id regardless of which field the endpoint filled.
func (a *Actor) Key() string {
	if a.ID != "" {
		return a.ID
	}
	return a.ActorID
}

// DeployOptions are the optional fields of PUT /v1/definitions.
type DeployOptions struct {
	ParentID         string            `json:"parentId,omitempty"`
	HistoryPath      []string          `json:"historyPath,omitempty"`
	StateMapping     map[string]string `json:"stateMapping,omitempty"`
	ContextTransform map[string]string `json:"contextTransform,omitempty"`
	ConfirmToken     string            `json:"confirmToken,omitempty"`
}

func (c *Client) do(ctx context.Context, method, path string, in any, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		e := &Error{Status: res.StatusCode, Message: strings.TrimSpace(string(raw))}
		if json.Unmarshal(raw, &e.Body) == nil {
			if m, ok := e.Body["error"].(string); ok {
				e.Message = m
			} else if m, ok := e.Body["message"].(string); ok {
				e.Message = m
			}
			e.Code, _ = e.Body["code"].(string)
		}
		return e
	}
	if out != nil && len(raw) > 0 {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// Health checks GET /v1/health.
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	return out, c.do(ctx, http.MethodGet, "/v1/health", nil, &out)
}

// Deploy releases a definition version. The response may be a 201 deployment or a 200
// {"status":"requires_confirmation", ...}; both are returned as a map.
func (c *Client) Deploy(ctx context.Context, id string, definition any, opts *DeployOptions) (map[string]any, error) {
	body := map[string]any{"id": id, "definition": definition}
	if opts != nil {
		b, _ := json.Marshal(opts)
		_ = json.Unmarshal(b, &body)
		body["id"], body["definition"] = id, definition
	}
	var out map[string]any
	return out, c.do(ctx, http.MethodPut, "/v1/definitions", body, &out)
}

// Preview returns what deploying would do, without deploying.
func (c *Client) Preview(ctx context.Context, parentID string, definition any, opts *DeployOptions) (map[string]any, error) {
	body := map[string]any{"parentId": parentID, "definition": definition}
	if opts != nil {
		if len(opts.HistoryPath) > 0 {
			body["historyPath"] = opts.HistoryPath
		}
		if len(opts.StateMapping) > 0 {
			body["stateMapping"] = opts.StateMapping
		}
	}
	var out map[string]any
	return out, c.do(ctx, http.MethodPost, "/v1/definitions/preview", body, &out)
}

// Import converts a Step Functions / SCXML / BPMN document (format "" = auto-detect).
func (c *Client) Import(ctx context.Context, source any, format string) (map[string]any, error) {
	body := map[string]any{"source": source}
	if format != "" {
		body["format"] = format
	}
	var out map[string]any
	return out, c.do(ctx, http.MethodPost, "/v1/definitions/import", body, &out)
}

// Spawn starts an actor. definitionID may be a version id, the family root id, or the machine name.
func (c *Client) Spawn(ctx context.Context, definitionID string, initialContext map[string]any) (*Actor, error) {
	if initialContext == nil {
		initialContext = map[string]any{}
	}
	var a Actor
	return &a, c.do(ctx, http.MethodPost, "/v1/actors", map[string]any{"definitionId": definitionID, "initialContext": initialContext}, &a)
}

// SendOptions are optional event fields.
type SendOptions struct{ IdempotencyKey string }

// Send delivers an event; payload is merged into the actor context.
func (c *Client) Send(ctx context.Context, actorID, eventType string, payload map[string]any, opts ...SendOptions) (*Actor, error) {
	body := map[string]any{"type": eventType}
	if payload != nil {
		body["payload"] = payload
	}
	if len(opts) > 0 && opts[0].IdempotencyKey != "" {
		body["idempotencyKey"] = opts[0].IdempotencyKey
	}
	var a Actor
	return &a, c.do(ctx, http.MethodPost, "/v1/actors/"+url.PathEscape(actorID)+"/event", body, &a)
}

// Get returns an actor snapshot.
func (c *Client) Get(ctx context.Context, actorID string) (*Actor, error) {
	var a Actor
	return &a, c.do(ctx, http.MethodGet, "/v1/actors/"+url.PathEscape(actorID), nil, &a)
}

// Events returns an actor's event history.
func (c *Client) Events(ctx context.Context, actorID string, limit int) (map[string]any, error) {
	var out map[string]any
	return out, c.do(ctx, http.MethodGet, "/v1/actors/"+url.PathEscape(actorID)+"/events?limit="+strconv.Itoa(limit), nil, &out)
}

// Terminate stops an actor (its state is kept).
func (c *Client) Terminate(ctx context.Context, actorID string) error {
	return c.do(ctx, http.MethodDelete, "/v1/actors/"+url.PathEscape(actorID), nil, nil)
}

// Schedule delivers an event at fireAt.
func (c *Client) Schedule(ctx context.Context, actorID, eventType string, fireAt time.Time, payload map[string]any) (map[string]any, error) {
	body := map[string]any{"type": eventType, "fireAt": fireAt.UnixMilli()}
	if payload != nil {
		body["payload"] = payload
	}
	var out map[string]any
	return out, c.do(ctx, http.MethodPost, "/v1/actors/"+url.PathEscape(actorID)+"/schedule", body, &out)
}

// ── Signatures ──────────────────────────────────────────────────────────────

// VerifyWebhook checks X-StateKeep-Signature on a webhook delivery.
func VerifyWebhook(secret string, rawBody []byte, signatureHeader string) bool {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(rawBody)
	return hmac.Equal([]byte("sha256="+hex.EncodeToString(m.Sum(nil))), []byte(signatureHeader))
}

// Sign computes the signature StateKeep puts on remote-implementation calls.
func Sign(secret, timestamp string, rawBody []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(timestamp + "."))
	m.Write(rawBody)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// ── Remote implementations ──────────────────────────────────────────────────

// Request is what StateKeep sends to a remote guard/action.
type Request struct {
	ActorID      string         `json:"actorId"`
	DefinitionID string         `json:"definitionId"`
	State        any            `json:"state"`
	Context      map[string]any `json:"context"`
	Event        map[string]any `json:"event"`
	// JobID identifies one action job across retries: pass it downstream as an
	// idempotency key (see docs/side-effects.md).
	JobID string `json:"jobId,omitempty"`
}

// Delivery modes: what StateKeep does when an action attempt was sent but never answered.
const (
	Idempotent = "idempotent"   // send again; the side effect dedupes on Request.JobID
	Verify     = "verify"       // ask the Verifier first
	AtMostOnce = "at-most-once" // never repeat; a human decides (the default)
)

// VerifyResult answers "did job X happen?". Done=nil means nobody can tell.
type VerifyResult struct {
	Done *bool          `json:"done"`
	Send map[string]any `json:"send,omitempty"`
}

// ActionResult optionally sends a follow-up event to the actor.
type ActionResult struct {
	Send map[string]any `json:"send,omitempty"`
}

// Implementations is an http.Handler serving remote guards and actions. Mount it at
// the prefix configured in STATEKEEP_REMOTE_URL, e.g. http.Handle("/statekeep/", http.StripPrefix("/statekeep", impl)).
type Implementations struct {
	Secret    string
	MaxSkew   time.Duration
	guards    map[string]func(Request) (bool, error)
	actions   map[string]func(Request) (*ActionResult, error)
	delivery  map[string]string
	verifiers map[string]func(Request) (VerifyResult, error)
}

// NewImplementations creates an empty handler.
func NewImplementations(secret string) *Implementations {
	return &Implementations{Secret: secret, MaxSkew: 5 * time.Minute,
		guards: map[string]func(Request) (bool, error){}, actions: map[string]func(Request) (*ActionResult, error){},
		delivery: map[string]string{}, verifiers: map[string]func(Request) (VerifyResult, error){}}
}

// Guard registers a guard.
func (s *Implementations) Guard(name string, fn func(Request) (bool, error)) { s.guards[name] = fn }

// Action registers an action. Its delivery mode defaults to AtMostOnce (Verify when a
// Verifier is registered). Returning an error means "it did not happen" (safe to retry).
func (s *Implementations) Action(name string, fn func(Request) (*ActionResult, error)) {
	s.actions[name] = fn
}

// ActionWithDelivery registers an action with an explicit delivery mode.
func (s *Implementations) ActionWithDelivery(name, mode string, fn func(Request) (*ActionResult, error)) {
	s.actions[name] = fn
	s.delivery[name] = mode
}

// Verifier registers the "did job X happen?" check used by the Verify mode.
func (s *Implementations) Verifier(name string, fn func(Request) (VerifyResult, error)) {
	s.verifiers[name] = fn
}

func (s *Implementations) deliveryOf(name string) string {
	if m, ok := s.delivery[name]; ok {
		return m
	}
	if _, ok := s.verifiers[name]; ok {
		return Verify
	}
	return AtMostOnce
}

func (s *Implementations) verify(r *http.Request, body []byte) bool {
	ts := r.Header.Get("X-StateKeep-Timestamp")
	ms, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || time.Since(time.UnixMilli(ms)).Abs() > s.MaxSkew {
		return false
	}
	return hmac.Equal([]byte(Sign(s.Secret, ts, body)), []byte(r.Header.Get("X-StateKeep-Signature")))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ServeHTTP implements GET /manifest, POST /guards/{name}, POST /actions/{name}.
func (s *Implementations) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if !s.verify(r, body) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad signature"})
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if r.Method == http.MethodGet && len(parts) == 1 && parts[0] == "manifest" {
		g, a := []string{}, []string{}
		for k := range s.guards {
			g = append(g, k)
		}
		d := map[string]string{}
		for k := range s.actions {
			a = append(a, k)
			d[k] = s.deliveryOf(k)
		}
		writeJSON(w, http.StatusOK, map[string]any{"guards": g, "actions": a, "delivery": d})
		return
	}
	if r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "actions" && parts[2] == "status" {
		name, _ := url.PathUnescape(parts[1])
		var req Request
		_ = json.Unmarshal(body, &req)
		fn, ok := s.verifiers[name]
		if !ok {
			writeJSON(w, http.StatusOK, VerifyResult{}) // no verifier: nobody can tell
			return
		}
		res, err := fn(req)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}
	if r.Method == http.MethodPost && len(parts) == 2 {
		name, _ := url.PathUnescape(parts[1])
		var req Request
		_ = json.Unmarshal(body, &req)
		switch parts[0] {
		case "guards":
			if fn, ok := s.guards[name]; ok {
				v, err := fn(req)
				if err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, map[string]bool{"result": v})
				return
			}
		case "actions":
			if fn, ok := s.actions[name]; ok {
				res, err := fn(req)
				if err != nil {
					// an error return means the action did not happen → 422: safe to retry
					writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
					return
				}
				if res == nil {
					res = &ActionResult{}
				}
				writeJSON(w, http.StatusOK, res)
				return
			}
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
