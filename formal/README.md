# APV in Lean 4: machine-checked core results

This directory holds the formalization from the APV paper (`APV.lean`) and an executable oracle built from it (`Oracle.lean`, `oracle.sh`). `test/test_model_oracle.js` runs the oracle against the routing code (see *Model vs code* below).

Everything is in `APV.lean`. It uses Lean 4 core only: no Mathlib, no Lake. It has no `sorry`, `admit`, `native_decide` or `axiom` declarations. The `#print axioms` audit at the end of the file lists only `propext`, `Classical.choice` and `Quot.sound`.

* **Lean version:** `Lean (version 4.12.0, x86_64-unknown-linux-gnu, commit dc2533473114, Release)`, from the official GitHub release tarball.
* **Build:** `./build.sh`. It type-checks `APV.lean`, fails on any error, forbidden token or non-standard axiom, and ends with `OK: ...`.

## Model

* **Definitions, configurations and contexts** are abstract types. Families are an abstract type with decidable equality, and `wff : Def → Fam`.
* **Fingerprints** are an abstract type with decidable equality. A pattern is `exact h | wild`, and "matches" means wildcard or `h = fp`. The theorems therefore talk about fingerprint equality. This is the paper's "exact histories" reading whenever `H` is injective.
* **Actor:** `(d, q, x, fp, keys, ell, st)`, where `keys` is the regional set `K_a` and `st ∈ {active, finished, stranded}`.
* **Scalar change-point:** `CP = (fam, t, pat, r, tgt)`. A registry is a `List`.
  * `RegUniq`: registry condition 1.
  * `OneLoc`: "one location per (family, t)".
  * `RegWF`: `wff tgt = fam`.
* **Parallel change-point:** `PCP = (fam, t, sel, r, tgt)`, where `sel : List Key` is used as a set, `sub S T := S.all (· ∈ T)`, and `|S|` is `S.length`. The tie-break `comp(S)` and `id(d')` are arbitrary `Nat`-valued functions.
* **State mappings:** `μ : Def → Cfg → Option Cfg` and `τ : Def → Ctx → Option Ctx`, indexed by the target definition.
* **Generic core:** a `Kind` says how to read a change-point's family, time, target and match. `SelOK R sel` says that a selection rule returns a least-time applicable change-point, and returns `none` only when nothing applies. Progress, termination, completeness and safety are proved once for every `SelOK` rule, then used for `acc`, `accP` and `accPlus`.
* **Units:**
  * `UChain`: one complete routing phase. It keeps migrating until `sel = none`, or until a hop strands the actor. It is never cut off.
  * `Run`: an actor's whole life. Hops (the registry may change between units) are interleaved with event steps `EvStep`.

## Theorem map

| Paper | Lean name(s) | Notes / deviation |
|---|---|---|
| Def 3.3 `Acc` | `acc`, `acc_spec`, `acc_selOK` | Least element of the filtered registry, ordered lexicographically by (t, exact<wild, higher r). |
| Thm 3.4 Determinism | `determinism`, `acc_eq_iff` | Any two least applicable change-points are equal. Only registry condition 1 is needed. |
| Def 3.5 Migration / stranding | `migrate`, `migrate_*` | As in the paper. |
| Lem 4.1 | `hop_advances` | `ℓ ≤ t_c`, `ℓ' = t_c+1 > ℓ`. |
| Thm 4.2 (a)(b) | `chain_progress`, `run_progress`, `run_invI` | Over whole runs: ℓ never decreases, and the times of the change-points used strictly increase. Invariant (I) is preserved. |
| Thm 4.2 (c) | `chain_nodup`, `run_nodup`, `chain_length_le`, `chain_length_le_times`, `chain_length_le_R`, `routeU_complete`, `routeU_complete_R` | No change-point, (family, t) or location is used twice. Hops ≤ number of distinct pending times of the family (≤ the paper's locations count) and ≤ `|R|`. Routing with a budget of `|R|` hops, i.e. at most `|R|+1` selector calls, always reaches a fixpoint or a stranding. |
| Thm 5.2 Completeness | `completeness_scalar`, `completeness_scalar_routeU` | The serialization hypothesis is explicit: `hser : aStart = aCommit` (no event step between the commit and the start of the first unit after it), `hvis : c ∈ R`, and the phase is a pure, complete routing phase. Conclusion: the actor passes through c's location with `r ≥ r_c`, or it is stranded after hops that are all `< t_c`. |
| Thm 6.1 Configuration safety | `run_safe`, `spawn_safe`, `evStep_active` | `valid : Def → Cfg → Prop`. The hypotheses are that `μ d` maps into `valid d` and that `δ d` stays inside `valid d`. Only active actors take event steps. |
| Thm 7.4 Parallel determinism | `leP_total`, `leP_trans`, `leP_antisymm`, `par_determinism`, `accP_spec` | The order is a total preorder. It is antisymmetric (a total order) on each family's registry under `PRegUniq` and the proviso `NoCollision` (no `comp` collision within the same (family, t)). The `id(d')` component is never needed. |
| Def 7.5 / Prop 7.6 | `Admits`, `Built`, `built_witness`, `no_arbitrary` | Strengthened form: if the winner and another applicable change-point tie on t and \|S\| but have different targets, they have the same selector and the loser has a strictly smaller r. |
| Def 7.7 (revised) | `accPlus`, `accPlus_some`, `accPlus_none`, `accPlus_tie`, `accPlus_le`, `accPlus_selOK` | Acc⁺ takes the earlier of the two, and the scalar one on ties. It is never later than either component, and it is exactly a minimum-time applicable change-point over `union R Rp`. |
| Thm 4.2 under Acc⁺ | `progress_plus` (+ the generic lemmas) | |
| Thm 5.2 under Acc⁺, scalar c | `completeness_plus_scalar` | Holds unchanged. Because ties go to the scalar change-point, a parallel one can never shadow c. |
| Thm 5.2 under Acc⁺, parallel c | `completeness_plus_par`, `completeness_plus_par_clean` | **Deviation, see below.** |
| Thm 8.1 (a) Collection frontier | `prune`, `prune_applicable`, `acc_prune`, `accP_prune`, `accPlus_prune`, `frontier_persists` | Hypothesis: `Φ ≤ ℓ_a` for the actor, where `wff d_a = f` (this covers new actors that start at ℓ ≥ Φ). Pruning `t < Φ` in family f leaves `Acc`, `Acc_∥` and `Acc⁺` unchanged, and the hypothesis persists along runs. |
| Thm 8.1 (b) | `acc_max_refinement` | A refinement that is not the highest at its location is never chosen. |

## Deviations and discrepancies

1. **Completeness for parallel change-points (revised Def 7.7).** The literal scalar conclusion, "passes through c's location", is false for a parallel change-point c, for two reasons:
   * **Larger selectors win.** A larger applicable selector at the same time `t_c` wins by design.
   * **Scalar ties win.** If a scalar change-point of family `f_c` also sits at `t_c` and applies, the tie rule picks it.

   What is proved (`completeness_plus_par`): the actor is routed through a change-point of `f_c` at exactly `t_c`, or it is stranded at an earlier hop. If that change-point is parallel, it was the least one in a state where c was still applicable, so `|S| ≥ |S_c|`.

   With the extra hypothesis `NoMix` (no (family, t) carries both a scalar and a parallel change-point, which holds when every deployment is one kind at a fresh time), `completeness_plus_par_clean` shows that the change-point is parallel with `|S| ≥ |S_c|`. If the registry was also built under Def 7.5, a same-size winner with a different target has exactly `S_c` (a later refinement).
2. **Thm 7.4.** The no-collision proviso is stated per (family, t). Selectors are compared as lists, so stored selectors are assumed to be normalized. The last key component `id(d')` is not needed.
3. **Thm 8.1.** The paper derives "future actors start at ℓ ≥ t_c + 1" from Prop 5.8. Here, as instructed, it is a hypothesis (`Φ ≤ ℓ_a`).
4. **Unused and used registry conditions.** `OneLoc` is used only by completeness. `RegWF` (from Def 3.1) is needed so that hops keep the actor in its family.

No other statement needed a correction.

5. **Regional sets are fixed across hops.** `migrate_keys` keeps `K_a` unchanged by a migration. In StateKeep (and the paper's definition over *active* regions) a mapping can leave a parallel state and change `K_a`; the paper's Proposition 7.8 therefore has a third outcome ("an earlier hop leaves `S_c ⊄ K_a`"), and the Lean theorem covers the case without it.

## Model vs code

The theorems are about the Lean functions, not the JavaScript and C that route actors. To connect the two, `Oracle.lean` runs the **same** definitions (`accPlus`, and the chain `routeU` with total state mappings) as a program: `oracle.sh` type-checks `APV.lean` together with `Oracle.lean` and runs `main`, which reads routing questions from stdin (format in the file header).

`test/test_model_oracle.js` (part of `scripts/run-tests.sh`; skipped without Lean 4.12) generates random registries of scalar (exact and wildcard) and parallel change-points, including scalar/parallel ties, loads each into the runtime through `registerScalar` / `registerParallel`, and checks that three code paths produce the oracle's routing chain hop by hop: `lookup()` (C engine plus digest checks, used for live routing), `simulateLookup()` (pure JS, used before a deployment commits) and `predictRouting()` (the deployment-analysis chain driver). Each model number stands for a real v2 fingerprint, and each regional key for a (region path, fingerprint) pair. Default 1,000 cases (`ORACLE_RUNS`).

Mutation check: changing the scalar-wins tie rule in `lookup()` to `<=`, or the time filter in `simulateLookup()` to `<=`, makes the test fail with the first differing case.

What this does **not** cover: the event interpreter, state mappings and context transforms (the model takes them as given functions), persistence and the cluster protocol. Those are covered by the integration, chaos and cluster suites, not by proofs.
