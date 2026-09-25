package statekeep

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

var machine = map[string]any{"id": "goloan", "initial": "draft", "states": map[string]any{
	"draft":    map[string]any{"on": map[string]any{"SUBMIT": "review"}},
	"review":   map[string]any{"on": map[string]any{"APPROVE": []any{map[string]any{"target": "approved", "guard": "cond:amount < 1000000"}, map[string]any{"target": "manual"}}}},
	"approved": map[string]any{"type": "final"}, "manual": map[string]any{"type": "final"},
}}

func live(t *testing.T) *Client {
	u := os.Getenv("STATEKEEP_URL")
	if u == "" {
		t.Skip("STATEKEEP_URL not set")
	}
	return New(u, os.Getenv("STATEKEEP_API_KEY"))
}

func TestLifecycle(t *testing.T) {
	sk, ctx := live(t), context.Background()
	if _, err := sk.Deploy(ctx, "goloan-v1", machine, nil); err != nil {
		t.Fatal(err)
	}
	a, err := sk.Spawn(ctx, "goloan-v1", map[string]any{"amount": 5000})
	if err != nil || a.State() != "draft" {
		t.Fatalf("spawn: %v %v", err, a)
	}
	if a, err = sk.Send(ctx, a.Key(), "SUBMIT", map[string]any{"docs": 2}); err != nil || a.State() != "review" {
		t.Fatalf("submit: %v %v", err, a)
	}
	got, _ := sk.Get(ctx, a.Key())
	if got.Context["docs"] != float64(2) {
		t.Fatalf("payload not merged into context: %v", got.Context)
	}
	if a, _ = sk.Send(ctx, a.Key(), "APPROVE", nil); a.State() != "approved" {
		t.Fatalf("approve → %v", a.StateValue)
	}
	_, err = sk.Send(ctx, a.Key(), "SUBMIT", nil)
	if !IsCode(err, "ACTOR_TERMINATED") {
		t.Fatalf("want ACTOR_TERMINATED, got %v", err)
	}
	if _, err = sk.Get(ctx, "missing"); err == nil || err.(*Error).Status != 404 {
		t.Fatalf("want 404, got %v", err)
	}
}

func TestIdempotencyAndPreview(t *testing.T) {
	sk, ctx := live(t), context.Background()
	_, _ = sk.Deploy(ctx, "goloan-v1", machine, nil)
	a, _ := sk.Spawn(ctx, "goloan-v1", nil)
	_, _ = sk.Send(ctx, a.Key(), "SUBMIT", nil, SendOptions{IdempotencyKey: "go-k1"})
	r, err := sk.Send(ctx, a.Key(), "SUBMIT", nil, SendOptions{IdempotencyKey: "go-k1"})
	if err != nil || !r.Idempotent {
		t.Fatalf("second send should be idempotent: %v %+v", err, r)
	}
	p, err := sk.Preview(ctx, "goloan-v1", machine, nil)
	if err != nil || p["migration"] == nil {
		t.Fatalf("preview: %v %v", err, p)
	}
}

func TestImplementationsHandler(t *testing.T) {
	impl := NewImplementations("sec")
	impl.Guard("big", func(r Request) (bool, error) { return r.Context["amount"].(float64) > 10, nil })
	impl.Action("notify", func(r Request) (*ActionResult, error) {
		return &ActionResult{Send: map[string]any{"type": "NOTIFIED"}}, nil
	})
	call := func(method, path string, body []byte, sig string) *httptest.ResponseRecorder {
		ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("X-StateKeep-Timestamp", ts)
		if sig == "" {
			sig = Sign("sec", ts, body)
		}
		req.Header.Set("X-StateKeep-Signature", sig)
		w := httptest.NewRecorder()
		impl.ServeHTTP(w, req)
		return w
	}
	body := []byte(`{"context":{"amount":50}}`)
	if w := call(http.MethodPost, "/guards/big", body, ""); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte(`"result":true`)) {
		t.Fatalf("guard: %d %s", w.Code, w.Body)
	}
	if w := call(http.MethodPost, "/actions/notify", body, ""); !bytes.Contains(w.Body.Bytes(), []byte("NOTIFIED")) {
		t.Fatalf("action: %s", w.Body)
	}
	if w := call(http.MethodGet, "/manifest", nil, ""); !bytes.Contains(w.Body.Bytes(), []byte(`"big"`)) {
		t.Fatalf("manifest: %s", w.Body)
	}
	if w := call(http.MethodPost, "/guards/big", body, "sha256=forged"); w.Code != 401 {
		t.Fatalf("forged signature accepted: %d", w.Code)
	}
	// delivery modes, status endpoint, error = "did not happen"
	impl.ActionWithDelivery("charge", Idempotent, func(r Request) (*ActionResult, error) { return nil, nil })
	impl.Action("refund", func(r Request) (*ActionResult, error) { return nil, errors.New("bank down") })
	impl.Verifier("refund", func(r Request) (VerifyResult, error) {
		done := r.JobID == "j-yes"
		return VerifyResult{Done: &done}, nil
	})
	m := call(http.MethodGet, "/manifest", nil, "").Body.String()
	for _, want := range []string{`"charge":"idempotent"`, `"notify":"at-most-once"`, `"refund":"verify"`} {
		if !strings.Contains(m, want) {
			t.Fatalf("manifest missing %s: %s", want, m)
		}
	}
	if w := call(http.MethodPost, "/actions/refund", body, ""); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("action error should be 422, got %d", w.Code)
	}
	if w := call(http.MethodPost, "/actions/refund/status", []byte(`{"jobId":"j-yes"}`), ""); !strings.Contains(w.Body.String(), `"done":true`) {
		t.Fatalf("status: %s", w.Body)
	}
	if w := call(http.MethodPost, "/actions/notify/status", []byte(`{"jobId":"x"}`), ""); !strings.Contains(w.Body.String(), `"done":null`) {
		t.Fatalf("no verifier should answer done:null, got %s", w.Body)
	}
}

func TestVerifyWebhook(t *testing.T) {
	body := []byte(`{"x":1}`)
	m := hmac.New(sha256.New, []byte("s"))
	m.Write(body)
	good := "sha256=" + hex.EncodeToString(m.Sum(nil))
	if !VerifyWebhook("s", body, good) {
		t.Fatal("valid signature rejected")
	}
	if VerifyWebhook("s", body, "sha256=bad") {
		t.Fatal("bad signature accepted")
	}
}
