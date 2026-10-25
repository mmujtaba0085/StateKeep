# StateKeep — Go SDK

```go
import "github.com/mmujtaba0085/StateKeep/sdks/go/statekeep"

sk := statekeep.New("http://localhost:3001", os.Getenv("STATEKEEP_API_KEY"))
a, err := sk.Spawn(ctx, "loan", map[string]any{"amount": 50000})
a, err = sk.Send(ctx, a.Key(), "SUBMIT", map[string]any{"documents": 3})
if statekeep.IsCode(err, "ACTOR_TERMINATED") { ... }
```

Serve guards/actions to StateKeep (docs/remote-implementations.md):

```go
impl := statekeep.NewImplementations(os.Getenv("STATEKEEP_REMOTE_SECRET"))
impl.Guard("isCreditOk", func(r statekeep.Request) (bool, error) {
    return r.Context["amount"].(float64) < 1_000_000, nil
})
impl.Action("sendOffer", func(r statekeep.Request) (*statekeep.ActionResult, error) {
    return &statekeep.ActionResult{Send: map[string]any{"type": "OFFER_SENT"}}, nil
})
http.Handle("/statekeep/", http.StripPrefix("/statekeep", impl))
```

Also: `Deploy`, `Preview`, `Import`, `Get`, `Events`, `Terminate`, `Schedule`, `VerifyWebhook`.
Tests: `STATEKEEP_URL=http://localhost:3001 go test ./...`.

## Side effects: never silently repeated

```go
impl.ActionWithDelivery("chargeCard", statekeep.Idempotent, charge) // retried; use req.JobID as the idempotency key
impl.Action("refundOrder", refund)
impl.Verifier("refundOrder", refundHappened)                          // → Verify mode
impl.Action("sendSms", sms)                                           // default: AtMostOnce
```

Returning an error from an action means "it did not happen" (HTTP 422, safe to retry). The Go
handler has no built-in job store: use `Idempotent` with a key-aware API or a `Verifier`. See `docs/side-effects.md`.
